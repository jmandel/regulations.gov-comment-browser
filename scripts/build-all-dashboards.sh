#!/bin/bash

# Build all regulation dashboards from SQLite databases
# This script can be run both locally and in GitHub Actions

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
DB_DIR="${DB_DIR:-dbs}"
OUTPUT_DIR="${OUTPUT_DIR:-dist}"
TEMP_DATA_DIR="temp-data"

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

# Check prerequisites
check_prerequisites() {
    if ! command -v bun &> /dev/null; then
        log_error "bun is not installed. Please install bun first."
        exit 1
    fi
    
    if [ ! -f "src/cli.ts" ]; then
        log_error "src/cli.ts not found. Are you running from the project root?"
        exit 1
    fi
    
    if [ ! -d "dashboard" ]; then
        log_error "dashboard directory not found. Are you in the correct directory?"
        exit 1
    fi
}

# Install dependencies
install_dependencies() {
    log_info "Installing dependencies..."
    bun install
    cd dashboard && bun install && cd ..
}

# Build dashboard for a single regulation
build_dashboard() {
    local db_file="$1"
    local regulation_id=$(basename "$db_file" .sqlite)
    
    log_info "Building dashboard for $regulation_id..."
    
    # Print SHA256 hash for traceability
    if command -v sha256sum &> /dev/null; then
        echo "SHA256 for $db_file:"
        sha256sum "$db_file"
    fi
    
    # Generate data files for this regulation
    log_info "Generating data files..."
    bun run src/cli.ts build-website "$regulation_id" --output "$TEMP_DATA_DIR"
    
    # Copy data to dashboard public directory
    rm -rf dashboard/public/data
    mkdir -p dashboard/public
    cp -r "$TEMP_DATA_DIR" dashboard/public/data
    
    # Build the dashboard
    log_info "Building React dashboard..."
    cd dashboard
    bun run build
    cd ..
    
    # Copy built dashboard to dist directory
    mkdir -p "$OUTPUT_DIR/$regulation_id"
    cp -r dashboard/dist/* "$OUTPUT_DIR/$regulation_id/"
    
    # Clean up temp data
    rm -rf "$TEMP_DATA_DIR"
    
    log_info "✅ Dashboard built successfully for $regulation_id"
}

# Main execution
main() {
    log_info "Starting dashboard build process..."
    
    # Check prerequisites
    check_prerequisites
    
    # Parse arguments
    ONLY_REGULATIONS=()
    while [[ $# -gt 0 ]]; do
        case $1 in
            --skip-install)
                SKIP_INSTALL=true
                shift
                ;;
            --db-dir)
                DB_DIR="$2"
                shift 2
                ;;
            --output)
                OUTPUT_DIR="$2"
                shift 2
                ;;
            --only)
                ONLY_REGULATIONS+=("$2")
                shift 2
                ;;
            --help)
                echo "Usage: $0 [options]"
                echo "Options:"
                echo "  --skip-install    Skip dependency installation"
                echo "  --db-dir DIR      Directory containing SQLite databases (default: dbs)"
                echo "  --output DIR      Output directory for built dashboards (default: dist)"
                echo "  --only REG_ID     Build only this regulation (can be specified multiple times)"
                echo "  --help            Show this help message"
                echo ""
                echo "Examples:"
                echo "  $0                                    # Build all dashboards"
                echo "  $0 --only AHRQ-2025-0002-0001        # Build only AHRQ-2025-0002-0001"
                echo "  $0 --only CMS-2025-0050-0031 --only AHRQ-2025-0002-0001  # Build two specific dashboards"
                exit 0
                ;;
            *)
                log_error "Unknown option: $1"
                exit 1
                ;;
        esac
    done
    
    # Install dependencies unless skipped
    if [ "$SKIP_INSTALL" != "true" ]; then
        install_dependencies
    fi
    
    # Check if database directory exists
    if [ ! -d "$DB_DIR" ]; then
        log_error "Database directory $DB_DIR not found"
        exit 1
    fi
    
    # Check if any databases exist
    shopt -s nullglob  # Make glob return empty array if no matches
    
    # If --only flags were specified, build list from those
    if [ ${#ONLY_REGULATIONS[@]} -gt 0 ]; then
        db_files=()
        for reg_id in "${ONLY_REGULATIONS[@]}"; do
            db_path="$DB_DIR/$reg_id.sqlite"
            if [ -f "$db_path" ]; then
                db_files+=("$db_path")
            else
                log_warning "Database not found for $reg_id: $db_path"
            fi
        done
        
        if [ ${#db_files[@]} -eq 0 ]; then
            log_error "None of the specified databases were found"
            exit 1
        fi
    else
        # Build all databases
        db_files=("$DB_DIR"/*.sqlite)
    fi
    
    shopt -u nullglob
    
    if [ ${#db_files[@]} -eq 0 ]; then
        log_error "No SQLite databases found in $DB_DIR"
        log_info "Contents of $DB_DIR:"
        ls -la "$DB_DIR" || echo "Directory not accessible"
        exit 1
    fi
    
    # Create output directory
    mkdir -p "$OUTPUT_DIR"
    
    # Build dashboard for each database
    log_info "Found ${#db_files[@]} database(s) to process"
    
    # Track what we actually built
    BUILT_DASHBOARDS=()
    
    for db_file in "${db_files[@]}"; do
        # Skip WAL and SHM related files and other sqlite variants
        if [[ "$db_file" == *.sqlite-* ]] || [[ "$db_file" == *.sqlite.* ]]; then
            continue
        fi
        
        # Skip if file doesn't exist (shouldn't happen with nullglob)
        [ -e "$db_file" ] || continue
        
        build_dashboard "$db_file"
        BUILT_DASHBOARDS+=("$(basename "$db_file" .sqlite)")
    done
    
    # Generate landing page
    log_info "Generating landing page..."
    bun run src/cli.ts generate-landing-page --db-dir "$DB_DIR" --output "$OUTPUT_DIR/index.html"
    
    log_info "🎉 Dashboard build completed successfully!"
    log_info "Output directory: $OUTPUT_DIR"
    
    # Show what was actually built in this run
    if [ ${#BUILT_DASHBOARDS[@]} -gt 0 ]; then
        log_info "Built dashboards in this run:"
        for dashboard in "${BUILT_DASHBOARDS[@]}"; do
            echo "  - $dashboard"
        done
    else
        log_warning "No dashboards were built (all were skipped)"
    fi
}

# Run main function
main "$@"