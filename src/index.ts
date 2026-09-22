import { loadDotenv } from "./config/env.js";
import { createApp } from "./app.js";
import mongoose from "mongoose";

loadDotenv();

const PORT = Number(process.env.PORT ?? 3000);
const MONGODB_URI = process.env.MONGODB_URI;

if (MONGODB_URI) {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("Connected to MongoDB");
  } catch (err) {
    console.error("Failed to connect to MongoDB:", err);
  }
}

const app = createApp();

app.listen(PORT, () => {
  console.log(`server listening on http://localhost:${PORT}`);
});
