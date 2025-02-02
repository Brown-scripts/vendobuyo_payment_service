const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
    paymentStatus: {
      type: String,
      enum: ["pending", "completed", "failed"],
      default: "pending",
    },
    paymentMethod: { type: String },
    paymentDate: { type: Date, default: Date.now }, // ✅ Set default date
    amount: { type: Number, required: true },
    transactionReference: { type: String, required: true, unique: true }, // ✅ Fix name
  },
  { timestamps: true }
);

module.exports = mongoose.model("Payment", paymentSchema);