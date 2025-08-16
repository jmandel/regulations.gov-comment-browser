#!/bin/bash

# Build FloodGate app separately
# This script builds the FloodGate form letter generation app

set -e  # Exit on error

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
OUTPUT_DIR="${OUTPUT_DIR:-dist}"

# Function to print colored messages
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

# Main execution
main() {
    log_info "Starting FloodGate build process..."
    
    # Check if floodgate directory exists
    if [ ! -d "floodgate" ]; then
        log_error "floodgate directory not found. Are you running from the project root?"
        exit 1
    fi
    
    # Check if bun is installed
    if ! command -v bun &> /dev/null; then
        log_error "bun is not installed. Please install bun first."
        exit 1
    fi
    
    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --output)
                OUTPUT_DIR="$2"
                shift 2
                ;;
            --help)
                echo "Usage: $0 [options]"
                echo "Options:"
                echo "  --output DIR      Output directory for built FloodGate app (default: dist)"
                echo "  --help            Show this help message"
                echo ""
                echo "Example:"
                echo "  $0                           # Build to dist/floodgate"
                echo "  $0 --output public           # Build to public/floodgate"
                exit 0
                ;;
            *)
                log_error "Unknown option: $1"
                exit 1
                ;;
        esac
    done
    
    # Enter floodgate directory
    cd floodgate
    
    # Install dependencies if needed
    if [ ! -d "node_modules" ]; then
        log_info "Installing FloodGate dependencies..."
        bun install
    fi
    
    # Build the FloodGate app
    log_info "Building FloodGate app..."
    bun build index.html --outdir="../$OUTPUT_DIR/floodgate" --minify
    
    # Copy the example campaign JSON file to the output directory
    log_info "Copying campaign data..."
    cp floodgate-example-work-requirements.json "../$OUTPUT_DIR/floodgate/"
    
    # Return to root directory
    cd ..
    
    log_info "✅ FloodGate built successfully"
    log_info "Output location: $OUTPUT_DIR/floodgate"
}

# Run main function
main "$@"