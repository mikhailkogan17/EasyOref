# RPi Deployment

## Overview

EasyOref runs on a Raspberry Pi as a Docker container, pulling images from GHCR.

## Prerequisites

- Raspberry Pi with 64-bit OS and Docker installed
- SSH access to RPi

## Deploy

### 1. SSH into RPi

```bash
ssh pi@raspberrypi.local
```

### 2. Create project directory

```bash
mkdir -p ~/easyoref && cd ~/easyoref
```

### 3. Create config.yaml

```yaml
city_ids: [722]              # your city ID
language: ru

telegram:
  bot_token: "YOUR_TOKEN"
  chat_id: "YOUR_CHAT_ID"
```

### 4. Create docker-compose.yml

```yaml
services:
  easyoref:
    image: ghcr.io/mikhailkogan17/easyoref:latest
    container_name: easyoref
    restart: unless-stopped
    ports:
      - "3100:3100"
    volumes:
      - easyoref-data:/app/data
      - ./config.yaml:/app/config.yaml:ro

volumes:
  easyoref-data:
```

### 5. Start

```bash
docker compose up -d
```

### 6. Verify

```bash
curl http://localhost:3100/health
docker logs easyoref --tail 20
```

## Update

```bash
cd ~/easyoref
docker compose pull
docker compose up -d
```

## Troubleshooting

```bash
# Check container status
docker ps

# View logs
docker logs easyoref --tail 50

# Restart
docker compose restart

# Health check
curl http://localhost:3100/health
```
