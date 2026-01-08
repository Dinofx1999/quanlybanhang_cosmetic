require("dotenv").config();

const env = {
  PORT: process.env.PORT || 3000,
  MONGO_URI: process.env.MONGO_URI || "mongodb://127.0.0.1:27017/cosmetics_pos",
  JWT_SECRET: process.env.JWT_SECRET || "CHANGE_ME",
  CORS_ORIGIN: process.env.CORS_ORIGIN || "*",
};

module.exports = { env };
