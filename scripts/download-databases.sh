#!/bin/bash

# Script to download SQLite databases from Google Drive into dbs/
#
# Downloads into a temporary directory and copies only the .sqlite files into dbs/. Nothing
# already in dbs/ is deleted, and a local database with the same name as a downloaded one is kept
# unless --overwrite is given (a local DB may hold work in progress that isn't published yet).

set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

FOLDER_URL="https://drive.google.com/drive/folders/1XBm4lp-ZPZs59I_OJSe8gg1sYRPFpzp_"
OVERWRITE=false
[ "$1" = "--overwrite" ] && OVERWRITE=true

if ! command -v gdown &> /dev/null; then
    echo -e "${RED}gdown is not installed. Please install it with: pip install gdown${NC}"
    exit 1
fi

echo -e "${BLUE}📥 Downloading SQLite databases from Google Drive...${NC}"

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

# Older gdown needs --remaining-ok for folders over 50 files; gdown 6 removed the flag
EXTRA_ARGS=()
gdown --help 2>/dev/null | grep -q -- "--remaining-ok" && EXTRA_ARGS+=(--remaining-ok)

gdown --folder "$FOLDER_URL" "${EXTRA_ARGS[@]}" -O "$TMP_DIR/" || {
    echo -e "${RED}Folder download failed.${NC}"
    exit 1
}

mkdir -p dbs
copied=0
kept=0
while IFS= read -r -d '' file; do
    name=$(basename "$file")
    if [ -e "dbs/$name" ] && [ "$OVERWRITE" != true ]; then
        echo -e "${YELLOW}Keeping local dbs/$name (use --overwrite to replace it)${NC}"
        kept=$((kept + 1))
        continue
    fi
    mv "$file" "dbs/$name"
    copied=$((copied + 1))
done < <(find "$TMP_DIR" -type f -name "*.sqlite" -print0)

if [ "$copied" -eq 0 ] && [ "$kept" -eq 0 ]; then
    echo -e "${RED}No SQLite files found in the download${NC}"
    exit 1
fi

# List databases
echo -e "\n${GREEN}✅ Downloaded $copied database(s); kept $kept existing local file(s):${NC}"
ls -lh dbs/*.sqlite 2>/dev/null

echo -e "\n${GREEN}✅ Database download complete${NC}"
