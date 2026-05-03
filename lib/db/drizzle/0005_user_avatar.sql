-- Migration 0005: add avatar_url column to users for profile editing
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar_url" text;
