"""
Configuration Settings for Rubinot Autonomous Bot
"""

class Settings:
    """Global configuration settings"""
    
    # Vision thresholds
    HP_LOW_THRESHOLD = 35.0  # Percentage - trigger healing below this
    MANA_LOW_THRESHOLD = 20.0  # Percentage - use mana potion below this
    
    # Critical thresholds (emergency)
    HP_CRITICAL_THRESHOLD = 15.0
    MANA_CRITICAL_THRESHOLD = 10.0
    
    # Capture settings
    CAPTURE_FPS_TARGET = 60
    SCREEN_CAPTURE_METHOD = "mss"  # or "rapidshot"
    
    # Input humanization
    INPUT_DELAY_MIN_MS = 45
    INPUT_DELAY_MAX_MS = 160
    MOUSE_NOISE_ENABLED = True
    KEYBOARD_NOISE_ENABLED = True
    
    # Learning parameters
    RECORDING_INTERVAL_MS = 15
    TRAJECTORY_MIN_ACTIONS = 3
    TRAJECTORY_GAP_SECONDS = 2.0
    
    # Agent parameters
    AGENT_DECISION_INTERVAL_MS = 100
    CHAT_CHECK_INTERVAL_MS = 500
    MINIMAP_UPDATE_INTERVAL_MS = 200
    
    # Safety limits
    MAX_ACTIONS_PER_SECOND = 20
    STUCK_DETECTION_SECONDS = 5.0
    
    # Paths
    DATA_DIR = "data"
    RECORDINGS_DIR = "data/recordings"
    MEMORY_DIR = "data/memory"
    LOGS_DIR = "data/logs"
    
    # Interception driver (for kernel-level input)
    INTERCEPTION_DRIVER_PATH = "C:\\Windows\\System32\\Interception.dll"
    USE_KERNEL_INPUT = True
    
    # VLM Agent (mock for now)
    VLM_API_ENDPOINT = None  # Set when integrating real VLM
    VLM_MODEL = "mock_cognitive_agent"
    
    # Character profiles
    DEFAULT_PROFILE = {
        "character_name": "",
        "vocation": "knight",  # knight, paladin, sorcerer, druid
        "level": 1,
        "hp_potions": ["strong health potion", "great health potion"],
        "mana_potions": ["strong mana potion", "great mana potion"],
        "healing_items": ["stone skin amulet", "might ring"],
        "attack_spells": [],
        "support_spells": []
    }
