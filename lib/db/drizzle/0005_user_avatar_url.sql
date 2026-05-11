-- Migration 0005: add avatar_url column to users table for the profile editing page
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar_url" text;
