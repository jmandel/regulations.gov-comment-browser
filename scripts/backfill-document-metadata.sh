#!/bin/bash

# Backfill document metadata for existing databases
# This fetches title and agency info from regulations.gov API and saves to database

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

# Load .env file if it exists
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
    log_info "Loaded environment from .env file"
fi

# Check for API key
if [ -z "${REGSGOV_API_KEY:-}" ]; then
    log_error "REGSGOV_API_KEY not found"
    log_info "Please set it in .env file or as environment variable"
    exit 1
fi

DB_DIR="${1:-dbs}"

log_info "Backfilling document metadata for databases in $DB_DIR"

# Find all SQLite databases
for db_file in "$DB_DIR"/*.sqlite; do
    # Skip if no files found
    [ -e "$db_file" ] || continue
    
    # Skip WAL and SHM related files
    if [[ "$db_file" == *.sqlite-* ]] || [[ "$db_file" == *.sqlite.sqlite ]]; then
        continue
    fi
    
    # Extract document ID from filename
    document_id=$(basename "$db_file" .sqlite)
    
    log_info "Processing $document_id..."
    
    # Check if metadata already exists
    existing=$(sqlite3 "$db_file" "SELECT COUNT(*) FROM document_metadata WHERE document_id = '$document_id';" 2>/dev/null || echo "0")
    
    if [ "$existing" = "1" ]; then
        log_info "  Metadata already exists, skipping"
        continue
    fi
    
    # Fetch document details from API
    response=$(curl -s -H "X-Api-Key: $REGSGOV_API_KEY" \
        "https://api.regulations.gov/v4/documents/$document_id")
    
    if [ $? -ne 0 ] || [ -z "$response" ]; then
        log_error "  Failed to fetch document details"
        continue
    fi
    
    # Parse JSON response (requires jq)
    if ! command -v jq &> /dev/null; then
        log_error "jq is required but not installed. Please install jq first."
        exit 1
    fi
    
    # Extract fields
    title=$(echo "$response" | jq -r '.data.attributes.title // empty')
    docket_id=$(echo "$response" | jq -r '.data.attributes.docketId // empty')
    agency_id=$(echo "$response" | jq -r '.data.attributes.agencyId // empty')
    document_type=$(echo "$response" | jq -r '.data.attributes.documentType // empty')
    posted_date=$(echo "$response" | jq -r '.data.attributes.postedDate // empty')
    comment_start_date=$(echo "$response" | jq -r '.data.attributes.commentStartDate // empty')
    comment_end_date=$(echo "$response" | jq -r '.data.attributes.commentEndDate // empty')
    
    # If no agency_id, try to extract from docket_id
    if [ -z "$agency_id" ] && [ -n "$docket_id" ]; then
        agency_id=$(echo "$docket_id" | grep -oE '^[A-Z]+' || echo "")
    fi
    
    # Fetch agency name if we have agency_id
    agency_name=""
    if [ -n "$agency_id" ]; then
        agency_response=$(curl -s -H "X-Api-Key: $REGSGOV_API_KEY" \
            "https://api.regulations.gov/v4/agencies/$agency_id")
        
        if [ $? -eq 0 ] && [ -n "$agency_response" ]; then
            agency_name=$(echo "$agency_response" | jq -r '.data.attributes.name // empty')
        fi
    fi
    
    # Fallback values
    [ -z "$title" ] && title="$document_id"
    [ -z "$docket_id" ] && docket_id="$document_id"
    [ -z "$agency_name" ] && agency_name="$agency_id"
    [ -z "$document_type" ] && document_type="Unknown"
    
    # Create table if it doesn't exist
    sqlite3 "$db_file" "CREATE TABLE IF NOT EXISTS document_metadata (
        document_id TEXT PRIMARY KEY,
        title TEXT,
        docket_id TEXT,
        agency_id TEXT,
        agency_name TEXT,
        document_type TEXT,
        posted_date TEXT,
        comment_start_date TEXT,
        comment_end_date TEXT,
        metadata_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );"
    
    # Escape single quotes for SQL
    title_escaped="${title//\'/\'\'}"
    agency_name_escaped="${agency_name//\'/\'\'}"
    metadata_json="${response//\'/\'\'}"
    
    # Insert metadata
    sqlite3 "$db_file" "INSERT OR REPLACE INTO document_metadata (
        document_id, title, docket_id, agency_id, agency_name,
        document_type, posted_date, comment_start_date, comment_end_date,
        metadata_json, updated_at
    ) VALUES (
        '$document_id',
        '$title_escaped',
        '$docket_id',
        '$agency_id',
        '$agency_name_escaped',
        '$document_type',
        $([ -n "$posted_date" ] && echo "'$posted_date'" || echo "NULL"),
        $([ -n "$comment_start_date" ] && echo "'$comment_start_date'" || echo "NULL"),
        $([ -n "$comment_end_date" ] && echo "'$comment_end_date'" || echo "NULL"),
        '$metadata_json',
        CURRENT_TIMESTAMP
    );"
    
    log_info "  ✅ Saved metadata: $title"
    
    # Rate limiting
    sleep 1
done

log_info "🎉 Backfill complete!"