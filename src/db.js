const mongoose = require("mongoose");
const { env } = require("./config/env");

async function connectDB() {
  mongoose.set("strictQuery", true);
  await mongoose.connect(env.MONGO_URI, { autoIndex: true });
  console.log("[MongoDB] connected");
}

module.exports = { connectDB };
