#!/usr/bin/env python3
"""
Test script to verify Supabase connection and database setup.
Run this before using the main document processing script.
"""

import os
import toml
from pathlib import Path
from supabase import create_client, Client
from dotenv import load_dotenv

# Load environment variables (fallback for sensitive data)
load_dotenv()

def load_config():
    """Load configuration from config.toml file"""
    config_path = Path(__file__).parent / "config.toml"
    if not config_path.exists():
        raise FileNotFoundError(f"Config file not found: {config_path}")
    
    config = toml.load(config_path)
    
    # Override with environment variables if they exist
    if os.getenv('SUPABASE_URL'):
        config['supabase']['url'] = os.getenv('SUPABASE_URL')
    if os.getenv('SUPABASE_SERVICE_ROLE_KEY'):
        config['supabase']['service_role_key'] = os.getenv('SUPABASE_SERVICE_ROLE_KEY')
    if os.getenv('DEFAULT_ENTITY_ID'):
        config['supabase']['default_entity_id'] = os.getenv('DEFAULT_ENTITY_ID')
    
    return config

def test_connection():
    """Test Supabase connection and database setup"""
    print("🔍 Testing Supabase connection...")
    
    try:
        # Load configuration
        config = load_config()
        print("✅ Configuration loaded successfully")
        
        # Check required configuration
        supabase_url = config['supabase']['url']
        supabase_key = config['supabase']['service_role_key']
        default_entity_id = config['supabase']['default_entity_id']
        
        if not supabase_url or supabase_url == "your-supabase-url":
            print("❌ SUPABASE_URL is not properly configured in config.toml")
            return False
        
        if not supabase_key or supabase_key == "your-service-role-key-here":
            print("❌ SUPABASE_SERVICE_ROLE_KEY is not properly configured in config.toml")
            return False
        
        if not default_entity_id or default_entity_id == "your-default-entity-uuid-here":
            print("❌ DEFAULT_ENTITY_ID is not properly configured in config.toml")
            return False
        
        print("✅ Configuration values are set")
        
        # Test Backblaze configuration
        try:
            b2_config = config['backblaze']
            if (b2_config['key_id'] == "your-b2-key-id-here" or 
                b2_config['application_key'] == "your-b2-application-key-here"):
                print("⚠️  Backblaze B2 configuration needs to be updated in config.toml")
            else:
                print("✅ Backblaze B2 configuration appears to be set")
        except KeyError:
            print("❌ Backblaze B2 configuration missing from config.toml")
            return False
        
        # Initialize Supabase client
        supabase: Client = create_client(supabase_url, supabase_key)
        print("✅ Supabase client created successfully")
        
        # Test database connection by querying documents table
        response = supabase.table('documents').select('id, processing_status').limit(1).execute()
        print(f"✅ Database connection successful - found {len(response.data)} documents")
        
        # Check for pending documents
        pending_response = supabase.table('documents').select('id').eq('processing_status', 'pending').execute()
        pending_count = len(pending_response.data)
        print(f"📋 Found {pending_count} pending documents to process")
        
        # Test entity exists
        entity_response = supabase.table('entities').select('id, name').eq('id', default_entity_id).execute()
        if entity_response.data:
            entity_name = entity_response.data[0]['name']
            print(f"✅ Default entity found: {entity_name}")
        else:
            print("⚠️  Default entity not found - you may need to create it")
        
        return True
        
    except FileNotFoundError as e:
        print(f"❌ Configuration file not found: {e}")
        return False
    except Exception as e:
        print(f"❌ Connection test failed: {e}")
        return False

def main():
    """Main test function"""
    print("=" * 60)
    print("🚀 SUPABASE CONNECTION TEST")
    print("=" * 60)
    
    if test_connection():
        print("\n✅ All tests passed! You're ready to run the document processing script.")
        print("Run: python main.py")
    else:
        print("\n❌ Tests failed. Please check your configuration.")
        print("Make sure you have:")
        print("1. Updated config.toml with your Supabase credentials")
        print("2. Updated config.toml with your Backblaze B2 credentials") 
        print("3. Set up the database schema (sql/create_tables.sql)")
        print("4. Created at least one entity in the database")
        print("5. Uploaded some documents to process")
    
    print("=" * 60)

if __name__ == "__main__":
    main() 