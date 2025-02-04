require("dotenv").config();
const axios = require("axios");
const Payment = require("../models/Payment");
const Order = require("../models/Order");
const User = require("../models/User");

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

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

        // Call Paystack API
        const response = await axios.post(
            "https://api.paystack.co/transaction/initialize",
            { email, amount: amount * 100 },
            { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
        );

        const paymentLink = response.data.data.authorization_url;
        const transactionReference = response.data.data.reference;

        // Ensure transactionReference is not null
        if (!transactionReference) {
            return res.status(500).json({ message: "Failed to generate transaction reference" });
        }

        // Save payment
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

// 🚀 *Paystack Webhook Listener*
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

        res.status(200).json({ message: "Webhook processed successfully" });
    } catch (err) {
        res.status(500).json({ message: "Webhook processing failed", error: err.message });
    }
};
