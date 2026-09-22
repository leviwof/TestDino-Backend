import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

const userSchema = new Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  passwordHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

export type User = InferSchemaType<typeof userSchema>;

export const UserModel: Model<User> =
  (mongoose.models.User as Model<User>) ??
  mongoose.model<User>("User", userSchema);
