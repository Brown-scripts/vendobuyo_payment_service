// payment-service/models/Payment.js
const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
    paymentStatus: {
      type: String,
      enum: ["pending", "completed", "failed"],
      default: "pending",
    },
    paymentMethod: { type: String, required: true },
    paymentDate: { type: Date },
    amount: { type: Number, required: true },
    transactionId: { type: String, required: true, unique: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Payment", paymentSchema);
