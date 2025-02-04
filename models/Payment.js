const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }, // Added user reference
    paymentStatus: {
      type: String,
      enum: ["pending", "completed", "failed"],
      default: "pending",
    },
    paymentMethod: { type: String },
    paymentDate: { type: Date, default: Date.now },
    amount: { type: Number, required: true },
    transactionReference: { type: String, required: true, unique: true,sparse: true},
  },
  { timestamps: true }
);

module.exports = mongoose.model("Payment", paymentSchema);
