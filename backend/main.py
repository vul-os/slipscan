import time
import torch
import os
import json
import uuid
import toml
import requests
import hashlib
import base64
from datetime import datetime
from typing import Dict, List, Optional, Union
from transformers import Qwen2VLForConditionalGeneration, AutoTokenizer, AutoProcessor
from qwen_vl_utils import process_vision_info
from supabase import create_client, Client
from dotenv import load_dotenv
import gc
import logging
from pathlib import Path

# Load environment variables (fallback for sensitive data)
load_dotenv()

# Load configuration from config.toml
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
    if os.getenv('B2_KEY_ID'):
        config['backblaze']['key_id'] = os.getenv('B2_KEY_ID')
    if os.getenv('B2_APPLICATION_KEY'):
        config['backblaze']['application_key'] = os.getenv('B2_APPLICATION_KEY')
    if os.getenv('B2_BUCKET_NAME'):
        config['backblaze']['bucket_name'] = os.getenv('B2_BUCKET_NAME')
    if os.getenv('B2_BUCKET_ID'):
        config['backblaze']['bucket_id'] = os.getenv('B2_BUCKET_ID')
    
    return config

config = load_config()

# Set up logging
logging.basicConfig(
    level=getattr(logging, config['logging']['level']),
    format=config['logging']['format']
)
logger = logging.getLogger(__name__)

# Set environment variable to reduce memory fragmentation
os.environ['PYTORCH_CUDA_ALLOC_CONF'] = 'expandable_segments:True'

# Initialize Supabase client
supabase: Client = create_client(
    config['supabase']['url'], 
    config['supabase']['service_role_key']
)

class BackblazeB2Client:
    """Backblaze B2 API client for downloading documents"""
    
    def __init__(self, config: Dict):
        self.config = config['backblaze']
        self.auth_token = None
        self.api_url = None
        self.download_url = None
        self.download_auth_token = None
        
    async def authenticate(self):
        """Authenticate with Backblaze B2"""
        credentials = base64.b64encode(
            f"{self.config['key_id']}:{self.config['application_key']}".encode()
        ).decode()
        
        headers = {'Authorization': f'Basic {credentials}'}
        
        response = requests.get(
            f"{self.config['base_url']}/b2api/v2/b2_authorize_account",
            headers=headers
        )
        
        if not response.ok:
            raise Exception(f"B2 authentication failed: {response.status_code} - {response.text}")
        
        data = response.json()
        self.auth_token = data['authorizationToken']
        self.api_url = data['apiUrl']
        self.download_url = data['downloadUrl']
        
        logger.info("✅ B2 authentication successful")
    
    def get_download_authorization(self):
        """Get download authorization for the bucket"""
        if not self.auth_token:
            raise Exception("Must authenticate first")
        
        headers = {'Authorization': self.auth_token}
        data = {
            'bucketId': self.config['bucket_id'],
            'fileNamePrefix': '',
            'validDurationInSeconds': 3600
        }
        
        response = requests.post(
            f"{self.api_url}/b2api/v2/b2_get_download_authorization",
            headers=headers,
            json=data
        )
        
        if not response.ok:
            raise Exception(f"Failed to get download authorization: {response.status_code} - {response.text}")
        
        result = response.json()
        self.download_auth_token = result['authorizationToken']
        logger.info("✅ Download authorization obtained")
    
    def download_file(self, file_path: str, local_path: str) -> bool:
        """Download a file from B2 to local storage"""
        try:
            if not self.download_auth_token:
                self.get_download_authorization()
            
            # Remove leading slash if present
            file_path = file_path.lstrip('/')
            
            # Construct download URL
            download_url = f"{self.download_url}/file/{self.config['bucket_name']}/{file_path}"
            
            headers = {'Authorization': self.download_auth_token}
            
            logger.info(f"Downloading {file_path} from B2...")
            
            response = requests.get(download_url, headers=headers, stream=True)
            
            if not response.ok:
                logger.error(f"Failed to download {file_path}: {response.status_code} - {response.text}")
                return False
            
            # Ensure local directory exists
            os.makedirs(os.path.dirname(local_path), exist_ok=True)
            
            # Download file
            with open(local_path, 'wb') as f:
                for chunk in response.iter_content(chunk_size=8192):
                    f.write(chunk)
            
            logger.info(f"✅ Downloaded {file_path} to {local_path}")
            return True
            
        except Exception as e:
            logger.error(f"Error downloading {file_path}: {e}")
            return False

def get_gpu_info():
    """Get information about available GPUs"""
    if not torch.cuda.is_available():
        return []
    
    gpu_info = []
    for i in range(torch.cuda.device_count()):
        props = torch.cuda.get_device_properties(i)
        memory_total = props.total_memory / (1024**3)  # Convert to GB
        memory_free = (props.total_memory - torch.cuda.memory_allocated(i)) / (1024**3)
        
        gpu_info.append({
            'id': i,
            'name': props.name,
            'memory_total': memory_total,
            'memory_free': memory_free,
            'memory_allocated': torch.cuda.memory_allocated(i) / (1024**3)
        })
    
    return gpu_info

def choose_best_gpu_config(gpu_info):
    """Choose the best GPU configuration based on available memory"""
    if not gpu_info:
        return None
    
    # Sort GPUs by free memory (descending)
    sorted_gpus = sorted(gpu_info, key=lambda x: x['memory_free'], reverse=True)
    
    best_gpu = sorted_gpus[0]
    
    # Use single GPU configuration that was working
    configs = []
    
    # Single GPU with conservative memory allocation
    memory_limit = config['processing']['gpu_memory_limit']
    required_memory = float(memory_limit.replace('GiB', ''))
    
    if best_gpu['memory_free'] > required_memory:
        configs.append({
            'type': 'single_gpu',
            'device_map': f"cuda:{best_gpu['id']}",
            'max_memory': {best_gpu['id']: memory_limit},
            'description': f"Single GPU {best_gpu['id']} ({best_gpu['name']}) - {best_gpu['memory_free']:.1f}GB free"
        })
    
    return configs

def try_load_model(gpu_config):
    """Try to load model with given configuration"""
    print(f"\nTrying configuration: {gpu_config['description']}")
    print(f"Device map: {gpu_config['device_map']}")
    print(f"Max memory: {gpu_config['max_memory']}")
    
    try:
        # Clear GPU cache before loading
        torch.cuda.empty_cache()
        gc.collect()
        
        model = Qwen2VLForConditionalGeneration.from_pretrained(
            "Qwen/Qwen2-VL-2B-Instruct",
            torch_dtype=torch.bfloat16,
            device_map=gpu_config['device_map'],
            low_cpu_mem_usage=True,
            max_memory=gpu_config['max_memory']
        )
        
        # Use processor with configurable image resolution
        processor = AutoProcessor.from_pretrained(
            "Qwen/Qwen2-VL-2B-Instruct", 
            min_pixels=config['processing']['min_pixels'],
            max_pixels=config['processing']['max_pixels']
        )
        
        print("✅ Model loaded successfully, testing inference...")
        
        # Test inference with a simple text-only prompt to check memory
        test_messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Hello, this is a test."}
                ],
            }
        ]
        
        # Test inference
        text = processor.apply_chat_template(test_messages, tokenize=False, add_generation_prompt=True)
        inputs = processor(text=[text], padding=True, return_tensors="pt")
        
        # Move to appropriate device
        primary_device = get_primary_device(gpu_config)
        if torch.cuda.is_available():
            inputs = {k: v.to(primary_device) if torch.is_tensor(v) else v for k, v in inputs.items()}
        
        # Test generation with minimal tokens
        with torch.no_grad():
            test_ids = model.generate(
                **inputs,
                max_new_tokens=10,  # Very small for testing
                do_sample=False,
                pad_token_id=processor.tokenizer.eos_token_id,
                temperature=None,
                top_p=None,
                top_k=None
            )
        
        # Clean up test tensors
        del test_ids, inputs
        torch.cuda.empty_cache()
        
        print(f"✅ SUCCESS: Model loaded and tested with {gpu_config['type']} configuration")
        return model, processor, gpu_config
        
    except Exception as e:
        print(f"❌ FAILED: {str(e)}")
        # Clean up on failure
        if 'model' in locals():
            del model
        if 'processor' in locals():
            del processor
        if 'inputs' in locals():
            del inputs
        if 'test_ids' in locals():
            del test_ids
        torch.cuda.empty_cache()
        gc.collect()
        return None, None, None

def get_primary_device(gpu_config):
    """Get the primary device for input placement"""
    if gpu_config['type'] == 'single_gpu':
        return gpu_config['device_map']
    elif 'max_memory' in gpu_config:
        # Find the GPU with most memory allocation
        gpu_memories = {k: v for k, v in gpu_config['max_memory'].items() if isinstance(k, int)}
        if gpu_memories:
            primary_gpu = max(gpu_memories.keys(), key=lambda k: float(gpu_memories[k].replace('GiB', '')))
            return f"cuda:{primary_gpu}"
    return "cuda:0"  # Default fallback

def get_unprocessed_documents(limit: int = None) -> List[Dict]:
    """Fetch unprocessed documents from Supabase"""
    try:
        if limit is None:
            limit = config['processing']['batch_size']
        
        response = supabase.table('documents').select('*').eq('processing_status', 'pending').limit(limit).execute()
        return response.data
    except Exception as e:
        logger.error(f"Error fetching documents: {e}")
        return []

def create_document_prompt(document_type: str = "unknown") -> str:
    """Create a generic prompt for document extraction"""
    return f"""Extract all relevant information from this document (invoice, receipt, statement, or other financial document) and return it in JSON format. 

Return ONLY valid JSON with the following structure:

{{
  "document_type": "invoice|receipt|statement|other",
  "vendor_name": "string or null",
  "vendor_address": "string or null", 
  "customer_name": "string or null",
  "customer_address": "string or null",
  "document_number": "string or null",
  "transaction_id": "string or null",
  "date": "YYYY-MM-DD or null",
  "due_date": "YYYY-MM-DD or null",
  "subtotal": "decimal number or null",
  "tax_amount": "decimal number or null",
  "total_amount": "decimal number or null",
  "currency": "string or null",
  "payment_method": "string or null",
  "payment_terms": "string or null",
  "account_number": "string or null",
  "period_start": "YYYY-MM-DD or null",
  "period_end": "YYYY-MM-DD or null",
  "line_items": [
    {{
      "description": "string",
      "quantity": "decimal number or null",
      "unit_price": "decimal number or null",
      "total_price": "decimal number"
    }}
  ],
  "notes": "string or null",
  "confidence_score": "decimal between 0 and 1"
}}

Extract only information that is clearly visible. Use null for missing fields. Ensure all decimal numbers are properly formatted."""

def process_document_with_model(model, processor, gpu_config, document_path: str) -> Dict:
    """Process a single document with the vision model"""
    try:
        # Clear GPU cache before inference
        torch.cuda.empty_cache()
        
        # Create prompt
        prompt = create_document_prompt()
        
        messages = [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "image": document_path,
                    },
                    {
                        "type": "text", 
                        "text": prompt
                    },
                ],
            }
        ]
        
        # Preparation for inference
        text = processor.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
        image_inputs, video_inputs = process_vision_info(messages)
        inference_inputs = processor(
            text=[text],
            images=image_inputs,
            videos=video_inputs,
            padding=True,
            return_tensors="pt",
        )
        
        # Move inputs to the appropriate device
        primary_device = get_primary_device(gpu_config)
        if torch.cuda.is_available():
            inference_inputs = {k: v.to(primary_device) if torch.is_tensor(v) else v for k, v in inference_inputs.items()}
        
        # Inference: Generation of the output with memory optimization
        with torch.no_grad():
            generated_ids = model.generate(
                **inference_inputs, 
                max_new_tokens=config['processing']['max_new_tokens'],
                do_sample=False,
                pad_token_id=processor.tokenizer.eos_token_id,
                temperature=None,
                top_p=None,
                top_k=None
            )
        
        generated_ids_trimmed = [
            out_ids[len(in_ids) :] for in_ids, out_ids in zip(inference_inputs["input_ids"], generated_ids)
        ]
        output_text = processor.batch_decode(
            generated_ids_trimmed, skip_special_tokens=True, clean_up_tokenization_spaces=False
        )
        
        # Clear GPU cache after inference
        torch.cuda.empty_cache()
        
        # Parse JSON from output
        try:
            # Extract JSON from the output text
            json_start = output_text[0].find('{')
            json_end = output_text[0].rfind('}') + 1
            if json_start != -1 and json_end != -1:
                json_str = output_text[0][json_start:json_end]
                parsed_data = json.loads(json_str)
                return parsed_data
            else:
                logger.warning(f"No JSON found in output: {output_text[0]}")
                return {"error": "No valid JSON found in model output"}
        except json.JSONDecodeError as e:
            logger.error(f"JSON parsing error: {e}")
            return {"error": f"JSON parsing failed: {str(e)}", "raw_output": output_text[0]}
            
    except Exception as e:
        logger.error(f"Error processing document: {e}")
        return {"error": str(e)}

def save_document_data(document_id: str, extracted_data: Dict, entity_id: str) -> bool:
    """Save extracted document data to appropriate database tables"""
    try:
        # Update document status
        supabase.table('documents').update({
            'processing_status': 'completed',
            'confidence_score': extracted_data.get('confidence_score', 0.8),
            'document_date': extracted_data.get('date'),
            'total_amount': extracted_data.get('total_amount'),
            'entity_name': extracted_data.get('vendor_name'),
            'is_processed': True
        }).eq('id', document_id).execute()
        
        doc_type = extracted_data.get('document_type', 'other').lower()
        
        if doc_type == 'invoice':
            # Save invoice data
            invoice_data = {
                'document_id': document_id,
                'entity_id': entity_id,
                'invoice_number': extracted_data.get('document_number', ''),
                'vendor_name': extracted_data.get('vendor_name', ''),
                'vendor_address': extracted_data.get('vendor_address'),
                'customer_name': extracted_data.get('customer_name'),
                'customer_address': extracted_data.get('customer_address'),
                'invoice_date': extracted_data.get('date'),
                'due_date': extracted_data.get('due_date'),
                'subtotal': extracted_data.get('subtotal', 0),
                'tax_amount': extracted_data.get('tax_amount', 0),
                'total_amount': extracted_data.get('total_amount', 0),
                'currency': extracted_data.get('currency', 'USD'),
                'payment_terms': extracted_data.get('payment_terms'),
                'extraction_confidence': extracted_data.get('confidence_score', 0.8)
            }
            
            response = supabase.table('invoices').insert(invoice_data).execute()
            invoice_id = response.data[0]['id']
            
            # Save line items
            for i, item in enumerate(extracted_data.get('line_items', [])):
                if item.get('description'):
                    supabase.table('invoice_items').insert({
                        'invoice_id': invoice_id,
                        'line_number': i + 1,
                        'description': item['description'],
                        'quantity': item.get('quantity', 1),
                        'unit_price': item.get('unit_price', 0),
                        'line_total': item.get('total_price', 0)
                    }).execute()
                    
        elif doc_type == 'receipt':
            # Save receipt data
            receipt_data = {
                'document_id': document_id,
                'entity_id': entity_id,
                'receipt_number': extracted_data.get('document_number'),
                'transaction_id': extracted_data.get('transaction_id'),
                'merchant_name': extracted_data.get('vendor_name', ''),
                'merchant_address': extracted_data.get('vendor_address'),
                'purchase_date': extracted_data.get('date'),
                'subtotal': extracted_data.get('subtotal'),
                'tax_amount': extracted_data.get('tax_amount', 0),
                'total_amount': extracted_data.get('total_amount', 0),
                'currency': extracted_data.get('currency', 'USD'),
                'payment_method': extracted_data.get('payment_method'),
                'extraction_confidence': extracted_data.get('confidence_score', 0.8)
            }
            
            response = supabase.table('receipts').insert(receipt_data).execute()
            receipt_id = response.data[0]['id']
            
            # Save line items
            for i, item in enumerate(extracted_data.get('line_items', [])):
                if item.get('description'):
                    supabase.table('receipt_items').insert({
                        'receipt_id': receipt_id,
                        'line_number': i + 1,
                        'item_name': item['description'],
                        'quantity': item.get('quantity', 1),
                        'unit_price': item.get('unit_price'),
                        'total_price': item.get('total_price', 0)
                    }).execute()
                    
        elif doc_type == 'statement':
            # For statements, we'd need account info first
            # This is a simplified version
            logger.info(f"Statement processing not fully implemented for document {document_id}")
            
        return True
        
    except Exception as e:
        logger.error(f"Error saving document data: {e}")
        # Update document status to failed
        try:
            supabase.table('documents').update({
                'processing_status': 'failed',
                'error_message': str(e)
            }).eq('id', document_id).execute()
        except:
            pass
        return False

def main():
    """Main processing function"""
    print("🔍 Detecting GPU configuration...")
    gpu_info = get_gpu_info()
    
    if not gpu_info:
        print("❌ No CUDA GPUs available!")
        return
    
    print("\n📊 GPU Information:")
    for gpu in gpu_info:
        print(f"  GPU {gpu['id']}: {gpu['name']}")
        print(f"    Total memory: {gpu['memory_total']:.1f}GB")
        print(f"    Free memory: {gpu['memory_free']:.1f}GB")
        print(f"    Allocated: {gpu['memory_allocated']:.1f}GB")
    
    print("\n🎯 Generating optimal configurations...")
    configs = choose_best_gpu_config(gpu_info)
    
    if not configs:
        print("❌ No suitable GPU configuration found!")
        return
    
    model, processor, chosen_config = None, None, None
    
    print(f"\n🚀 Trying {len(configs)} configurations...")
    for i, gpu_config in enumerate(configs, 1):
        print(f"\n--- Configuration {i}/{len(configs)} ---")
        model, processor, chosen_config = try_load_model(gpu_config)
        if model is not None:
            break
    
    if model is None:
        print("\n❌ All configurations failed! Try reducing image resolution or using CPU-only mode.")
        return
    
    print(f"\n✅ Successfully loaded model with: {chosen_config['description']}")
    
    # Initialize Backblaze B2 client
    print("\n🔧 Initializing Backblaze B2 client...")
    b2_client = BackblazeB2Client(config)
    
    try:
        # Use sync version for now (can be made async later)
        import asyncio
        asyncio.run(b2_client.authenticate())
    except Exception as e:
        logger.error(f"Failed to authenticate with B2: {e}")
        return
    
    # Fetch unprocessed documents
    print(f"\n📥 Fetching unprocessed documents (batch size: {config['processing']['batch_size']})...")
    documents = get_unprocessed_documents()
    
    if not documents:
        print("📭 No unprocessed documents found.")
        return
    
    print(f"📋 Found {len(documents)} unprocessed documents")
    
    # Create temporary directory for downloaded files
    temp_dir = Path(__file__).parent / "temp_downloads"
    temp_dir.mkdir(exist_ok=True)
    
    # Process each document
    total_processed = 0
    total_failed = 0
    
    for doc in documents:
        document_id = doc['id']
        file_path = doc['file_path']
        
        print(f"\n🔄 Processing document {document_id}...")
        print(f"   B2 File: {file_path}")
        
        # Update status to processing
        try:
            supabase.table('documents').update({
                'processing_status': 'processing'
            }).eq('id', document_id).execute()
        except Exception as e:
            logger.error(f"Error updating document status: {e}")
            continue
        
        # Download file from B2
        local_filename = f"{document_id}_{Path(file_path).name}"
        local_file_path = temp_dir / local_filename
        
        if not b2_client.download_file(file_path, str(local_file_path)):
            logger.error(f"Failed to download {file_path}")
            total_failed += 1
            
            # Update document status to failed
            try:
                supabase.table('documents').update({
                    'processing_status': 'failed',
                    'error_message': 'Failed to download file from B2'
                }).eq('id', document_id).execute()
            except Exception as e:
                logger.error(f"Error updating failed document status: {e}")
            continue
        
        # Process document
        start_time = time.time()
        extracted_data = process_document_with_model(model, processor, chosen_config, str(local_file_path))
        processing_time = time.time() - start_time
        
        # Clean up downloaded file
        try:
            local_file_path.unlink()
        except:
            pass
        
        if 'error' in extracted_data:
            print(f"❌ Processing failed: {extracted_data['error']}")
            total_failed += 1
            
            # Update document status to failed
            try:
                supabase.table('documents').update({
                    'processing_status': 'failed',
                    'error_message': extracted_data['error']
                }).eq('id', document_id).execute()
            except Exception as e:
                logger.error(f"Error updating failed document status: {e}")
            continue
        
        # Save extracted data
        if save_document_data(document_id, extracted_data, doc['entity_id']):
            print(f"✅ Successfully processed in {processing_time:.2f}s")
            print(f"   Type: {extracted_data.get('document_type', 'unknown')}")
            print(f"   Vendor: {extracted_data.get('vendor_name', 'N/A')}")
            print(f"   Total: {extracted_data.get('total_amount', 'N/A')}")
            total_processed += 1
        else:
            print(f"❌ Failed to save data for document {document_id}")
            total_failed += 1
    
    # Clean up temp directory
    try:
        temp_dir.rmdir()
    except:
        pass
    
    print(f"\n🎉 Processing complete!")
    print(f"   ✅ Successfully processed: {total_processed}")
    print(f"   ❌ Failed: {total_failed}")
    print(f"   📈 Success rate: {(total_processed / len(documents) * 100):.1f}%")

if __name__ == "__main__":
    main()