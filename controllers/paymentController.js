require('dotenv').config();
const amqp = require("amqplib/callback_api");
const axios = require("axios");
const Payment = require("../models/Payment");
const User = require("../models/User");

// Paystack Secret Key
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// RabbitMQ Producer Function
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
};

// 🚀 *Initiate Payment*
exports.initiatePayment = async (req, res) => {
    try {
        const { orderId, amount, email } = req.body;

        // Validate required fields
        if (!orderId || !amount || !email) {
            return res.status(400).json({ message: "Missing required fields" });
        }

        // Create payment link via Paystack API
        const response = await axios.post(
            "https://api.paystack.co/transaction/initialize",
            { email, amount: amount * 100 },
            { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
        );

        const paymentLink = response.data.data.authorization_url;

        // Save Payment to Database
        const payment = new Payment({
            orderId,
            amount,
            paymentStatus: "pending",
            paymentDate: new Date(), // ✅ Store current date
            transactionReference: response.data.data.reference,
        });

        await payment.save();

        res.status(200).json({ message: "Payment initialized", paymentLink });
    } catch (err) {
        res.status(500).json({ message: "Payment initiation failed", error: err.message });
    }
};

// 🚀 *Verify Payment*
exports.verifyPayment = async (req, res) => {
    try {
        const { reference } = req.params;

        // Verify Payment with Paystack
        const response = await axios.get(
            `https://api.paystack.co/transaction/verify/${reference}`,
            { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
        );

        const transaction = response.data.data;

        // Find Payment and Populate Order → User
        const payment = await Payment.findOne({ transactionReference: reference })
            .populate({
                path: "orderId",
                populate: { path: "userId", select: "email phone" }
            });

        if (!payment) {
            return res.status(404).json({ message: "Payment not found" });
        }

        // Extract payment method from Paystack response
        const paystackMethod = transaction.channel || payment.paymentMethod || "unknown";

        // Update Payment Status and Method
        payment.paymentStatus = transaction.status === "success" ? "completed" : "failed";
        payment.paymentMethod = paystackMethod;
        await payment.save();

        // Prepare Notification with targetEmail & targetPhone
        const message = {
            paymentId: payment._id,
            orderId: payment.orderId._id,
            status: payment.paymentStatus,
            amount: payment.amount,
            transactionId: payment.transactionReference,
            paymentDate: payment.paymentDate,
            paymentMethod: payment.paymentMethod,
            targetEmail: payment.orderId.userId.email,
            targetPhone: payment.orderId.userId.phone,
        };

        sendToQueue("payment_status_queue", message);

        res.status(200).json({ message: "Payment verified", payment });
    } catch (err) {
        res.status(500).json({ message: "Payment verification failed", error: err.message });
    }
};

// 🚀 *Paystack Webhook Listener*
exports.paystackWebhook = async (req, res) => {
    try {
        const event = req.body;
        const transaction = event.data;

        // Find Payment and Populate Order → User
        const payment = await Payment.findOne({ transactionReference: transaction.reference })
            .populate({
                path: "orderId",
                populate: { path: "userId", select: "email phone" }
            });

        if (!payment) {
            return res.status(404).json({ message: "Payment not found" });
        }

        // Extract payment method from webhook
        const paystackMethod = transaction.channel || payment.paymentMethod || "unknown";

        // Update Payment Status and Method
        payment.paymentStatus = event.event === "charge.success" ? "completed" : "failed";
        payment.paymentMethod = paystackMethod;
        await payment.save();

        // Prepare Notification with targetEmail & targetPhone
        const message = {
            paymentId: payment._id,
            orderId: payment.orderId._id,
            status: payment.paymentStatus,
            amount: payment.amount,
            transactionId: payment.transactionReference,
            paymentDate: payment.paymentDate,
            paymentMethod: payment.paymentMethod,
            targetEmail: payment.orderId.userId.email,
            targetPhone: payment.orderId.userId.phone,
        };

        sendToQueue("payment_status_queue", message);

        res.status(200).json({ message: "Webhook processed" });
    } catch (err) {
        res.status(500).json({ message: "Webhook processing failed", error: err.message });
    }
};