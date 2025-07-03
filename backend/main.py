import time
import torch
import os
from transformers import Qwen2VLForConditionalGeneration, AutoTokenizer, AutoProcessor
from qwen_vl_utils import process_vision_info
import gc

# Set environment variable to reduce memory fragmentation
os.environ['PYTORCH_CUDA_ALLOC_CONF'] = 'expandable_segments:True'

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
    if best_gpu['memory_free'] > 4.0:
        configs.append({
            'type': 'single_gpu',
            'device_map': f"cuda:{best_gpu['id']}",
            'max_memory': {best_gpu['id']: '4.0GiB'},
            'description': f"Single GPU {best_gpu['id']} ({best_gpu['name']}) - {best_gpu['memory_free']:.1f}GB free (Conservative)"
        })
    
    return configs

def try_load_model(config):
    """Try to load model with given configuration"""
    print(f"\nTrying configuration: {config['description']}")
    print(f"Device map: {config['device_map']}")
    print(f"Max memory: {config['max_memory']}")
    
    try:
        # Clear GPU cache before loading
        torch.cuda.empty_cache()
        gc.collect()
        
        model = Qwen2VLForConditionalGeneration.from_pretrained(
            "Qwen/Qwen2-VL-2B-Instruct",
            torch_dtype=torch.bfloat16,
            device_map=config['device_map'],
            low_cpu_mem_usage=True,
            max_memory=config['max_memory']
        )
        
        # Use processor with even more reduced image resolution to save memory
        min_pixels = 128*28*28  # Reduced from 256*28*28
        max_pixels = 768*28*28  # Reduced from 1280*28*28
        processor = AutoProcessor.from_pretrained("Qwen/Qwen2-VL-2B-Instruct", min_pixels=min_pixels, max_pixels=max_pixels)
        
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
        primary_device = get_primary_device(config)
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
        
        print(f"✅ SUCCESS: Model loaded and tested with {config['type']} configuration")
        return model, processor, config
        
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

def get_primary_device(config):
    """Get the primary device for input placement"""
    if config['type'] == 'single_gpu':
        return config['device_map']
    elif 'max_memory' in config:
        # Find the GPU with most memory allocation
        gpu_memories = {k: v for k, v in config['max_memory'].items() if isinstance(k, int)}
        if gpu_memories:
            primary_gpu = max(gpu_memories.keys(), key=lambda k: float(gpu_memories[k].replace('GiB', '')))
            return f"cuda:{primary_gpu}"
    return "cuda:0"  # Default fallback

# Main execution
print("🔍 Detecting GPU configuration...")
gpu_info = get_gpu_info()

if not gpu_info:
    print("❌ No CUDA GPUs available!")
    exit(1)

print("\n📊 GPU Information:")
for gpu in gpu_info:
    print(f"  GPU {gpu['id']}: {gpu['name']}")
    print(f"    Total memory: {gpu['memory_total']:.1f}GB")
    print(f"    Free memory: {gpu['memory_free']:.1f}GB")
    print(f"    Allocated: {gpu['memory_allocated']:.1f}GB")

print("\n🎯 Generating optimal configurations...")
configs = choose_best_gpu_config(gpu_info)

model, processor, chosen_config = None, None, None

print(f"\n🚀 Trying {len(configs)} configurations...")
for i, config in enumerate(configs, 1):
    print(f"\n--- Configuration {i}/{len(configs)} ---")
    model, processor, chosen_config = try_load_model(config)
    if model is not None:
        break

if model is None:
    print("\n❌ All configurations failed! Try reducing image resolution or using CPU-only mode.")
    exit(1)

print(f"\n✅ Successfully loaded model with: {chosen_config['description']}")
model_load_end = time.time()

# Your existing inference code
messages = [
    {
        "role": "user",
        "content": [
            {
                "type": "image",
                "image": "/home/exo/Documents/slipscan-mono/backend/test.jpg",
            },
            {
                "type": "text", 
                "text": """Extract all relevant information from this invoice or receipt and return it in JSON format. Include the following fields if available:
{
  "vendor_name": "",
  "vendor_address": "",
  "invoice_number": "",
  "receipt_number": "",
  "date": "",
  "total_amount": "",
  "tax_amount": "",
  "subtotal": "",
  "currency": "",
  "payment_method": "",
  "line_items": [
    {
      "description": "",
      "quantity": "",
      "unit_price": "",
      "total_price": ""
    }
  ],
  "customer_info": "",
  "notes": ""
}

Please extract only the information that is clearly visible in the image and return valid JSON format."""
            },
        ],
    }
]

# Clear GPU cache before inference
torch.cuda.empty_cache()

print("\n🖼️  Starting image processing...")
inference_start = time.time()

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
primary_device = get_primary_device(chosen_config)
if torch.cuda.is_available():
    inference_inputs = {k: v.to(primary_device) if torch.is_tensor(v) else v for k, v in inference_inputs.items()}

# Inference: Generation of the output with memory optimization
with torch.no_grad():
    generated_ids = model.generate(
        **inference_inputs, 
        max_new_tokens=512,
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

inference_end = time.time()
processing_time = inference_end - inference_start

# Clear GPU cache after inference
torch.cuda.empty_cache()

print(f"\n✅ Image processing completed in {processing_time:.2f} seconds")
print("=" * 50)
print("OUTPUT:")
print(output_text)
print("=" * 50)
print(f"🎉 SUMMARY: Using {chosen_config['description']} - Image processed in {processing_time:.2f}s")