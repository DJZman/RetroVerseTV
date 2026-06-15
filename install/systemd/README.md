# RabbitEars TV systemd Services

RabbitEars TV can run as systemd user services, which means:
- Automatically starts on login
- Runs in background (no terminal windows)
- Automatic restart on failure
- Centralized logging via systemd journal
- Easy management with systemctl commands

## Installation

**Important:** Only install systemd services after you have RabbitEars TV configured and running stably. This is not part of the initial installation.

When ready, run:

```bash
bash install/install_services.sh
```

The installer will prompt you to select which services to enable:
- **Field Player** (rabbitears) - Core service, enabled by default
- **Cable Box** (rabbitears-cable-box) - Optional, for cable box interface
- **Remote Controller** (rabbitears-remote-controller) - Optional
- **OSD** (rabbitears-osd) - Optional, on-screen display overlay

Services are enabled but not started immediately. They will start automatically on next login, or you can start them manually.

## Managing Services

### Field Player (main service)

The field player is the core service that manages content playback. You'll restart this most often:

```bash
# Start
systemctl --user start rabbitears

# Stop
systemctl --user stop rabbitears

# Restart (most common)
systemctl --user restart rabbitears

# Check status
systemctl --user status rabbitears

# View logs
journalctl --user -u rabbitears -f
```

### All Services

```bash
# Start all
systemctl --user start rabbitears-*

# Stop all
systemctl --user stop rabbitears-*

# Restart all
systemctl --user restart rabbitears-*

# Check status of all
systemctl --user status rabbitears-*

# View all logs
journalctl --user -u rabbitears-* -f
```

### Individual Services

- `rabbitears` - Field Player (main content playback)
- `rabbitears-cable-box` - Cable Box interface
- `rabbitears-remote-controller` - Remote Controller
- `rabbitears-osd` - On-Screen Display (waits 30s before starting)

## Uninstall

```bash
bash install/uninstall_services.sh
```
