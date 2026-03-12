# RPi Deployment

## Overview

EasyOref runs on a Raspberry Pi as a native Node.js service via systemd (like Homebridge).

## Prerequisites

- Raspberry Pi with Node.js 20+ installed
- SSH access to RPi

## Install

### 1. Install Node.js (if not already)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

### 2. Install Redis

```bash
sudo apt install -y redis-server
sudo systemctl enable redis-server
sudo systemctl start redis-server
```

### 3. Install EasyOref

```bash
sudo npm install -g easyoref
```

### 4. Run setup wizard

```bash
easyoref init
```

The wizard creates `~/.easyoref/config.yaml` with your settings.

### 5. Install as service

```bash
sudo HOME=$HOME easyoref install
```

This creates a systemd service that starts automatically on boot.

### 6. Verify

```bash
easyoref status
curl http://localhost:3100/health
easyoref logs
```

## Update

```bash
sudo npm update -g easyoref
easyoref restart
```

## Service Management

```bash
easyoref status    # show service status
easyoref logs      # follow logs (journalctl)
easyoref restart   # restart service
easyoref stop      # stop service
easyoref start     # start service
easyoref uninstall # remove systemd service
```

## Troubleshooting

```bash
# Check service status
easyoref status

# View logs
easyoref logs

# Check Redis
redis-cli ping

# Health check
curl http://localhost:3100/health

# Manual run (foreground, for debugging)
easyoref stop
easyoref run
```
