# Choose mode: local or docker (default: local)
RUN_MODE ?= local
# Choose OS environment: wsl or linux (default: wsl)
OS_ENV ?= wsl
EXTRA_MOUNT ?= /dev/null:/dev/null

CATALOG_LOCATION ?= ../catalog
RUNTIME_LOCATION ?= ../runtime
CONFS_LOCATION ?= ../confs

# Default Docker Compose file
COMPOSE_FILE := docker/docker-compose.yml

# Default values — override only if not already set in environment
ifeq ($(OS_ENV),wsl)
DISPLAY ?= $(shell echo $$DISPLAY)
XDG_RUNTIME_DIR ?= /tmp
PULSE_SOCKET ?= /mnt/wslg/PulseServer
endif

ifeq ($(OS_ENV),linux)
DISPLAY ?= :0
XDG_RUNTIME_DIR ?= /run/user/$(shell id -u)
PULSE_SOCKET ?= /run/user/$(shell id -u)/pulse/native
endif

# Compose command with inline environment
define COMPOSE_ENV
DISPLAY=$(DISPLAY) \
XDG_RUNTIME_DIR=$(XDG_RUNTIME_DIR) \
PULSE_SOCKET=$(PULSE_SOCKET) \
EXTRA_MOUNT=$(EXTRA_MOUNT) \
CATALOG_LOCATION=$(CATALOG_LOCATION) \
RUNTIME_LOCATION=$(RUNTIME_LOCATION) \
CONFS_LOCATION=$(CONFS_LOCATION)
endef

## Build Docker Compose services with appropriate environment
docker-build:
	@echo "Building in $(MODE) mode with env:"
	@echo "  DISPLAY=$(DISPLAY)"
	@echo "  XDG_RUNTIME_DIR=$(XDG_RUNTIME_DIR)"
	@echo "  PULSE_SOCKET=$(PULSE_SOCKET)"
	@echo "  EXTRA_MOUNT=$(EXTRA_MOUNT)"
	
	$(COMPOSE_ENV) docker compose -f $(COMPOSE_FILE) build

docker-up:
	$(COMPOSE_ENV) docker compose -f $(COMPOSE_FILE) up -d

docker-down:
	$(COMPOSE_ENV) docker compose -f $(COMPOSE_FILE) down

rabbitears_station:
ifeq ($(RUN_MODE),docker)
	$(COMPOSE_ENV) docker compose -f $(COMPOSE_FILE) up -d
	docker exec -it rabbitears python3 /app/rabbitears_station.py $(ARGS)
	$(COMPOSE_ENV) docker compose -f $(COMPOSE_FILE) down
else
	@echo "Running rabbitears_station locally..."
	python3 rabbitears_station.py $(ARGS)
endif

rabbitears_player:
ifeq ($(RUN_MODE),docker)
	$(COMPOSE_ENV) docker compose -f $(COMPOSE_FILE) up -d
	docker exec -it rabbitears python3 /app/rabbitears_player.py $(ARGS)
	$(COMPOSE_ENV) docker compose -f $(COMPOSE_FILE) down
else
	@echo "Running rabbitears_player locally..."
	python3 rabbitears_player.py $(ARGS)
endif
