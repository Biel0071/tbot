# Rubinot Autonomous Bot - Directory Structure

## Project Architecture
```
rubinot_bot/
├── main.py                     # Entry point with GUI (Tkinter)
├── requirements.txt            # Dependencies
├── README.md                   # Documentation
├── config/
│   ├── __init__.py
│   ├── settings.py             # Global configurations
│   └── profiles.json           # Character profiles and settings
├── core/
│   ├── __init__.py
│   ├── engine.py               # Main game engine coordinator
│   ├── state_machine.py        # State management (Hunting, Refill, Training, etc.)
│   └── event_bus.py            # Async event communication between modules
├── vision/
│   ├── __init__.py
│   ├── capture.py              # Screen capture using mss/rapidshot
│   ├── vision.py               # HP/Mana reading, item detection, OCR
│   ├── minimap_parser.py       # Minimap analysis and pathfinding
│   └── templates/              # Image templates for UI elements
├── input_handler/
│   ├── __init__.py
│   ├── interceptor.py          # Interception driver wrapper (kernel-level)
│   ├── humanizer.py            # Human-like movement noise generator
│   └── keyboard_mouse.py       # Low-level input simulation
├── learning/
│   ├── __init__.py
│   ├── learning.py             # Imitation learning recorder/playback
│   ├── trajectory_encoder.py   # Encodes movement sequences
│   └── memory_bank.py          # Stores successful paths and failures
├── agent/
│   ├── __init__.py
│   ├── cognitive_agent.py      # VLM-based decision maker
│   ├── chat_parser.py          # In-game chat command interpreter
│   └── knowledge_base.py       # Game knowledge (items, monsters, vocations)
├── gui/
│   ├── __init__.py
│   ├── main_window.py          # Tkinter/PyQt main interface
│   └── overlay.py              # Floating button overlay
├── utils/
│   ├── __init__.py
│   ├── logger.py               # Logging utilities
│   ├── process_detector.py     # Rubinot process detection
│   └── calibration.py          # Auto-calibration of capture area
└── data/
    ├── recordings/             # Pilot recordings (.json/.pkl)
    ├── memory/                 # Learned paths and failure memories
    └── logs/                   # Runtime logs
```

## Key Features by Module

### Core Module
- Coordinates all subsystems
- Manages state transitions
- Event-driven architecture

### Vision Module
- High-speed screen capture (60+ FPS)
- HP/Mana percentage extraction via pixel analysis
- Inventory OCR for potion/runes counting
- Minimap parsing for navigation

### Input Handler Module
- Kernel-level input simulation via Interception driver
- Human-like noise injection (45-160ms delays, micro-tremors)
- Anti-detection movement patterns

### Learning Module
- "Record Pilot" mode for imitation learning
- Trajectory encoding with timestamps
- Memory bank for successful routes
- Failure pattern avoidance

### Agent Module
- Cognitive decision-making layer
- Chat command interpretation
- Game knowledge base integration
- Continuous evolution through experience

### GUI Module
- Simple Tkinter interface
- Floating autonomous toggle button
- Real-time status display
