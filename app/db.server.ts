import { PrismaClient } from "@prisma/client";

// Prevent multiple Prisma instances during hot reload in development.
// In production a single instance is created and reused.
declare global {
  var __db__: PrismaClient | undefined;
}

let db: PrismaClient;

if (process.env.NODE_ENV === "production") {
  db = new PrismaClient();
} else {
  if (!global.__db__) {
    global.__db__ = new PrismaClient();
  }
  db = global.__db__;
}

export { db };
