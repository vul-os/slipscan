-- Add avatar_url column to organizations table
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS avatar_url TEXT;
