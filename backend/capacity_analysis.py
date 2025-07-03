#!/usr/bin/env python3
"""
Capacity Analysis for Qwen2-VL Image Processing
Calculate maximum users for 1 instance running 24/7
"""

# Constants
SECONDS_PER_MONTH = 24 * 60 * 60 * 30  # 2,592,000 seconds
IMAGES_PER_USER_OPTIONS = [5, 10, 15]  # Images per user per month
CONVERSION_RATES = [0.001, 0.01, 0.025]  # 0.1%, 1%, and 2.5% conversion rates
PRICE_PER_CUSTOMER = 19.99  # R19.99 per customer per month

def estimate_processing_times():
    """Processing time estimates per image in seconds"""
    return {
        "optimistic_gpu": 2.0,      # High-end GPU (RTX 4090, A100) with optimizations
        "typical_gpu": 5.0,         # Mid-range GPU (RTX 3070, RTX 4060) 
        "budget_gpu": 10.0,         # Lower-end GPU (GTX 1660, RTX 3060)
        "measured_actual": 15.82,   # Actual measured processing time
        "conservative_gpu": 15.0,   # Conservative estimate for production
        "cpu_only": 30.0,           # CPU-only processing (very slow)
    }

def calculate_max_users(processing_time_per_image, images_per_user_per_month):
    """Calculate maximum users for 1 instance"""
    total_processing_time_per_user = processing_time_per_image * images_per_user_per_month
    max_users = int(SECONDS_PER_MONTH // total_processing_time_per_user)
    return max_users

def calculate_revenue_estimates(max_users):
    """Calculate revenue estimates based on conversion rates"""
    revenue_estimates = {}
    for rate in CONVERSION_RATES:
        customers = max_users * rate
        monthly_revenue = customers * PRICE_PER_CUSTOMER
        revenue_estimates[rate] = {
            'customers': customers,
            'monthly_revenue': monthly_revenue,
            'annual_revenue': monthly_revenue * 12
        }
    return revenue_estimates

def generate_user_capacity_table():
    """Generate table showing max users for each scenario"""
    
    print("QWEN2-VL USER CAPACITY ANALYSIS")
    print("=" * 80)
    print(f"1 Instance Running 24/7 ({SECONDS_PER_MONTH:,} seconds/month)")
    print("=" * 80)
    
    scenarios = estimate_processing_times()
    
    # Header
    print(f"\n{'Scenario':<20} {'Time/Image':<12} ", end="")
    for images in IMAGES_PER_USER_OPTIONS:
        print(f"{images} img/month"[:12].ljust(12), end="")
    print()
    
    print(f"{'(Hardware)':<20} {'(seconds)':<12} ", end="")
    for images in IMAGES_PER_USER_OPTIONS:
        print(f"{'Max Users':<12}", end="")
    print()
    
    print("-" * 80)
    
    # Calculate and display results
    for scenario_name, processing_time in scenarios.items():
        display_name = scenario_name.replace('_', ' ').title()
        print(f"{display_name:<20} {processing_time:<12} ", end="")
        
        for images_per_user in IMAGES_PER_USER_OPTIONS:
            max_users = calculate_max_users(processing_time, images_per_user)
            print(f"{max_users:<12}", end="")
        print()
    
    print("\n" + "=" * 80)
    print("DETAILED BREAKDOWN")
    print("=" * 80)
    
    # Show detailed calculations for typical GPU scenario
    typical_time = scenarios["measured_actual"]
    print(f"\nExample: Actual Measured Performance ({typical_time}s per image)")
    print("-" * 50)
    
    for images in IMAGES_PER_USER_OPTIONS:
        max_users = calculate_max_users(typical_time, images)
        time_per_user = typical_time * images
        total_images_per_month = max_users * images
        
        print(f"{images} images/user/month:")
        print(f"  • Time per user: {time_per_user}s/month")
        print(f"  • Max users: {max_users:,}")
        print(f"  • Total images processed: {total_images_per_month:,}/month")
        print()

    print("\n" + "=" * 80)
    print("REVENUE ANALYSIS")
    print("=" * 80)
    print(f"Based on R{PRICE_PER_CUSTOMER} monthly subscription per customer")
    print("-" * 50)
    
    # Show revenue estimates for measured actual performance
    measured_time = scenarios["measured_actual"]
    for images in IMAGES_PER_USER_OPTIONS:
        max_users = calculate_max_users(measured_time, images)
        revenue_estimates = calculate_revenue_estimates(max_users)
        
        print(f"\n{images} images/user/month ({max_users:,} max users):")
        for rate in CONVERSION_RATES:
            rate_percent = rate * 100
            customers = revenue_estimates[rate]['customers']
            monthly = revenue_estimates[rate]['monthly_revenue']
            
            print(f"  • {rate_percent}% conversion: {customers:.1f} customers")
            print(f"    Monthly revenue: R{monthly:,.2f}")

if __name__ == "__main__":
    generate_user_capacity_table() 