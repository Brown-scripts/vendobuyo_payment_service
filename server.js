const express = require("express");
const mongoose = require("mongoose");
const bodyParser = require("body-parser");
const paymentRoutes = require("./routes/paymentRoutes");

const app = express();
app.use(bodyParser.json());

mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.log(err));

app.use("", paymentRoutes);

const port = process.env.PORT || 3005;
app.listen(port, () => {
  console.log(`Payment Service running on port ${port}`);
});
