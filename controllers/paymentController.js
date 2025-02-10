require("dotenv").config();
const axios = require("axios");
const Payment = require("../models/Payment");
const Order = require("../models/Order");
const User = require("../models/User");
const amqp = require("amqplib");
const Product = require("../models/Product");

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// Function to publish message to RabbitMQ using async/await
const sendToQueue = async (queue, message) => {
  const rabbitmqURL = process.env.RABBITMQ_URL;
  try {
    const connection = await amqp.connect(rabbitmqURL); // Connect to RabbitMQ
    const channel = await connection.createChannel(); // Create a channel
    await channel.assertQueue(queue, { durable: true }); // Ensure the queue exists
    channel.sendToQueue(queue, Buffer.from(JSON.stringify(message)), { persistent: true }); // Send the message
    console.log("Sent message to queue:", message);

    // Close the connection after a small delay to ensure message delivery
    setTimeout(() => {
      channel.close();
      connection.close();
    }, 500);
  } catch (error) {
    console.error("Failed to send message to RabbitMQ:", error);
  }
};

// 🚀 *Initiate Payment*
exports.initiatePayment = async (req, res) => {
  try {
    const { orderId, email } = req.body;

    // Validate required fields
    if (!orderId || !email) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // Get Order (with user reference)
    const order = await Order.findById(orderId).populate("userId");
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Check if a pending payment already exists for the order
    const existingPayment = await Payment.findOne({ orderId, paymentStatus: "pending" });
    if (existingPayment) {
      return res.status(400).json({ message: "A payment is already pending for this order" });
    }

    // Validate amount
    const amount = order.totalPrice;
    if (!amount || amount <= 0) {
      return res.status(400).json({ message: "Invalid order amount" });
    }

    const amountInP = Math.round(amount * 100); // Convert to kobo

    // Call Paystack API to initialize payment
    const paystackPayload = {
      email,
      amount: amountInP,
    };

    console.log("🔗 Sending request to Paystack:", paystackPayload);

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      paystackPayload,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
    );

    // Extract payment details from Paystack response
    const paymentLink = response.data.data.authorization_url;
    const transactionReference = response.data.data.reference;

    // Ensure transactionReference is not null
    if (!transactionReference) {
      return res.status(500).json({ message: "Failed to generate transaction reference" });
    }

    // Save payment details in the database
    const payment = new Payment({
      orderId,
      userId: order.userId,
      amount,
      paymentStatus: "pending",
      paymentDate: new Date(),
      transactionReference,
    });

    await payment.save();

    res.status(200).json({ message: "Payment initialized", paymentLink });
  } catch (err) {
    console.error("🚨 Payment initiation failed:", err);
    res.status(500).json({ message: "Payment initiation failed", error: err.message });
  }
};

// 🚀 *Verify Payment*
exports.verifyPayment = async (req, res) => {
  try {
    const { reference } = req.params;

    // Verify payment with Paystack
    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
    );

    const transaction = response.data.data;
    if (!transaction) {
      return res.status(400).json({ message: "Invalid transaction reference" });
    }

    // Find Payment
    const payment = await Payment.findOne({ transactionReference: reference }).populate("orderId userId");
    if (!payment) {
      return res.status(404).json({ message: "Payment not found" });
    }

    // Update Payment Status
    payment.paymentStatus = transaction.status === "success" ? "completed" : "failed";
    payment.paymentMethod = transaction.channel || "unknown";
    await payment.save();

    res.status(200).json({ message: "Payment verified", payment });
  } catch (err) {
    res.status(500).json({ message: "Payment verification failed", error: err.message });
  }
};

// 🚀 *Paystack Webhook*
exports.paystackWebhook = async (req, res) => {
  try {
    const event = req.body;
    const transaction = event.data;

    // Find Payment associated with the transaction reference
    const payment = await Payment.findOne({ transactionReference: transaction.reference })
      .populate("orderId userId");

    if (!payment) {
      return res.status(404).json({ message: "Payment not found" });
    }

    // Find the Order without populating products to avoid schema error
    const order = await Order.findById(payment.orderId);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Get the single productId from the order (assuming only one product per order)
    const productId = order.products[0]?.productId;
    if (!productId) {
      return res.status(404).json({ message: "Product ID not found in order" });
    }

    // Manually fetch the product details using the Product model
    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    // Extract sellerId from the product
    const sellerId = product.sellerId;
    if (!sellerId) {
      return res.status(404).json({ message: "Seller ID not found in product" });
    }

    // Fetch seller email from the User model
    const seller = await User.findById(sellerId, "email");
    if (!seller || !seller.email) {
      return res.status(404).json({ message: "Seller email not found" });
    }

    // Update Payment Status
    payment.paymentStatus = event.event === "charge.success" ? "completed" : "failed";
    payment.paymentMethod = transaction.channel || "unknown";
    await payment.save();

    // Update Order Status to "processing" if payment is successful
    if (payment.paymentStatus === "completed") {
      order.status = "processing";
      await order.save();
    }

    // Prepare the message to be sent to the RabbitMQ queue
    const paymentUpdate = {
      orderId: order._id,
      userId: payment.userId._id,
      amount: payment.amount,
      sellerEmail: seller.email,  // Notify the seller
      buyerEmail: transaction.customer.email, // Notify the buyer
      paymentStatus: payment.paymentStatus,
      transactionReference: payment.transactionReference,
      product: {
        productId: product._id,
        productName: product.name, // Ensure the Product model has a name field
        quantity: order.products[0].quantity,
        price: order.products[0].price,
      },
    };

    // Publish payment status update to RabbitMQ
    await sendToQueue("payment_status_queue", paymentUpdate);

    res.status(200).json({ message: "Webhook processed successfully" });
  } catch (err) {
    console.error("🚨 Webhook processing failed:", err);
    res.status(500).json({ message: "Webhook processing failed", error: err.message });
  }
};

exports.getPaymentById = async (req, res) => {
  try {
      const { orderId } = req.params;
      const payment = await Payment.findById(orderId);

      if (!payment) {
          return res.status(404).json({ message: "Payment not found" });
      }

      res.status(200).json(payment);
  } catch (error) {
      console.error("Error fetching payment:", error);
      res.status(500).json({ message: "Server error", error: error.message });
  }
};

