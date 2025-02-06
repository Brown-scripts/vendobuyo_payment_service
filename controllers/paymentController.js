require("dotenv").config();
const axios = require("axios");
const Payment = require("../models/Payment");
const Order = require("../models/Order");
const User = require("../models/User");
const amqp = require("amqplib/callback_api");

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// Function to publish message to RabbitMQ
const sendToQueue = (queue, message) => {
  const rabbitmqURL = process.env.RABBITMQ_URL;
  amqp.connect(rabbitmqURL, (error0, connection) => {
    if (error0) {
      console.error("RabbitMQ connection error:", error0);
      return;
    }
    connection.createChannel((error1, channel) => {
      if (error1) {
        console.error("RabbitMQ channel error:", error1);
        return;
      }

      channel.assertQueue(queue, { durable: true });
      channel.sendToQueue(queue, Buffer.from(JSON.stringify(message)), { persistent: true });
      console.log("Sent message to queue:", message);
    });

    setTimeout(() => connection.close(), 500);
  });
}

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

        const amountInP = Math.round(amount * 100); 

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

exports.paystackWebhook = async (req, res) => {
    try {
        const event = req.body;
        const transaction = event.data;

        // Find Payment
        const payment = await Payment.findOne({ transactionReference: transaction.reference }).populate("orderId userId");
        if (!payment) {
            return res.status(404).json({ message: "Payment not found" });
        }

        // Update Payment Status
        payment.paymentStatus = event.event === "charge.success" ? "completed" : "failed";
        payment.paymentMethod = transaction.channel || "unknown";
        await payment.save();

        const userEmail = payment.userId.email;

        if (!userEmail) {
            return res.status(400).json({ message: "User email is missing" });
        }

        // Publish payment status update to RabbitMQ
        const paymentUpdate = {
            orderId: payment.orderId._id,
            userId: payment.userId._id,
            amount: payment.amount,
            targetEmail: userEmail, 
            paymentStatus: payment.paymentStatus,
            transactionReference: payment.transactionReference,
        };

        await sendToQueue('payment_status_queue', paymentUpdate);

        res.status(200).json({ message: "Webhook processed successfully" });
    } catch (err) {
        res.status(500).json({ message: "Webhook processing failed", error: err.message });
    }
};
