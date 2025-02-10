// payment-service/routes/paymentRoutes.js
const express = require("express");
const router = express.Router();
const paymentController = require("../controllers/paymentController");

router.post("/initiate", paymentController.initiatePayment);
router.get("/verify/:transactionId", paymentController.verifyPayment);
router.post("/webhook", paymentController.paystackWebhook);
router.get("/order/:orderId", paymentController.getPaymentById)

module.exports = router;
