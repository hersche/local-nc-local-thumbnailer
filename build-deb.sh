#!/bin/bash
set -e

APP_NAME="localthumbs-cli"
VERSION="1.0.1"
BUILD_DIR="packaging/debian"
PACKAGE_NAME="${APP_NAME}_${VERSION}_all.deb"

echo "Building $PACKAGE_NAME..."

# Ensure we are in the local-app directory
cd "$(dirname "$0")"

# Clean previous build artifacts in the lib folder
rm -rf $BUILD_DIR/usr/lib/$APP_NAME/*

# Copy app files
echo "Copying application files..."
cp index.js package.json package-lock.json $BUILD_DIR/usr/lib/$APP_NAME/

# Update env example in package
cp .env.example $BUILD_DIR/usr/share/$APP_NAME/$APP_NAME.env.example

# Install production dependencies
echo "Installing production dependencies..."
cd $BUILD_DIR/usr/lib/$APP_NAME/
npm install --production
cd - > /dev/null

# Set permissions
echo "Setting permissions..."
chmod 755 $BUILD_DIR/DEBIAN/postinst
chmod 755 $BUILD_DIR/usr/bin/$APP_NAME
chmod 644 $BUILD_DIR/lib/systemd/system/$APP_NAME.service

# Build the package
echo "Running dpkg-deb..."
dpkg-deb --build $BUILD_DIR $PACKAGE_NAME

echo "Success! Package created: $PACKAGE_NAME"
echo "To install: sudo dpkg -i $PACKAGE_NAME"
echo "Then configure: /etc/$APP_NAME/$APP_NAME.env"