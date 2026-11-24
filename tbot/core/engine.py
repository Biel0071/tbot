"""
Core Game Engine - Coordinates all subsystems
"""

import asyncio
import threading
from typing import Optional, Dict
from pathlib import Path

from config.settings import Settings
from vision.vision import VisionEngine, GameStatus
from learning.learning import ImitationLearner
from utils.logger import setup_logger

logger = setup_logger('engine')


class GameEngine:
    """
    Main game engine coordinating vision, input, learning, and agent modules.
    Runs in a separate thread to avoid blocking the GUI.
    """
    
    def __init__(self):
        self.vision_engine: Optional[VisionEngine] = None
        self.learning_module: Optional[ImitationLearner] = None
        
        self.is_running = False
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        
        # State tracking
        self.current_state: Dict = {}
        self.last_action_time = 0
        self.actions_per_second = 0
        self.stuck_timer = 0
        self.last_position = None
        
        logger.info("GameEngine initialized")
    
    def start(self):
        """Start the game engine in a background thread"""
        if self.is_running:
            logger.warning("Engine already running")
            return
        
        self._stop_event.clear()
        self.is_running = True
        
        # Initialize modules
        self.vision_engine = VisionEngine()
        self.learning_module = ImitationLearner()
        
        # Start main loop in background thread
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()
        
        logger.info("GameEngine started")
    
    def stop(self):
        """Stop the game engine"""
        if not self.is_running:
            return
        
        self._stop_event.set()
        self.is_running = False
        
        if self._thread:
            self._thread.join(timeout=5.0)
        
        logger.info("GameEngine stopped")
    
    def _run_loop(self):
        """Main engine loop (runs in background thread)"""
        try:
            # Create event loop for this thread
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            
            # Run async main loop
            loop.run_until_complete(self._async_main_loop())
            
        except Exception as e:
            logger.error(f"Engine loop error: {e}")
        finally:
            self.is_running = False
    
    async def _async_main_loop(self):
        """Async main loop coordinating all modules"""
        logger.info("Starting async main loop...")
        
        # Calibrate vision
        if not self.vision_engine.calibrate():
            logger.error("Vision calibration failed")
            return
        
        # Set up learning callbacks
        self.learning_module.set_state_callback(self._get_game_state_for_recording)
        
        cycle_count = 0
        
        while not self._stop_event.is_set():
            try:
                cycle_start = asyncio.get_event_loop().time()
                
                # 1. Get current game state from vision
                game_status = self.vision_engine.get_game_status()
                self._update_state(game_status)
                
                # 2. Record actions if in learning mode
                if self.learning_module.is_recording:
                    self._record_current_actions()
                
                # 3. Check for urgent reactions (HP/Mana low)
                await self._check_emergency_reactions(game_status)
                
                # 4. Parse chat for commands
                await self._parse_chat_commands(game_status)
                
                # 5. Execute learned behavior or default hunting pattern
                if not self.learning_module.is_recording:
                    await self._execute_behavior(game_status)
                
                # 6. Check for stuck detection
                self._check_stuck_detection()
                
                cycle_count += 1
                
                # Maintain target FPS
                cycle_time = asyncio.get_event_loop().time() - cycle_start
                target_cycle_time = 1.0 / Settings.CAPTURE_FPS_TARGET
                
                if cycle_time < target_cycle_time:
                    await asyncio.sleep(target_cycle_time - cycle_time)
                
                # Log stats periodically
                if cycle_count % 60 == 0:
                    logger.debug(f"Engine cycle {cycle_count}, APS: {self.actions_per_second}")
                
            except Exception as e:
                logger.error(f"Loop iteration error: {e}")
                await asyncio.sleep(0.1)  # Brief pause on error
        
        logger.info("Async main loop ended")
    
    def _update_state(self, game_status: GameStatus):
        """Update internal state from game status"""
        self.current_state = {
            'hp_percent': game_status.hp_percent,
            'mana_percent': game_status.mana_percent,
            'is_low_hp': game_status.is_low_hp,
            'is_low_mana': game_status.is_low_mana,
            'inventory': game_status.inventory_items,
            'chat_messages': game_status.chat_messages,
            'timestamp': asyncio.get_event_loop().time()
        }
    
    def _get_game_state_for_recording(self) -> Dict:
        """Get current state formatted for recording"""
        return {
            'position': self.last_position or (0, 0),
            'hp_percent': self.current_state.get('hp_percent', 100),
            'mana_percent': self.current_state.get('mana_percent', 100),
            'timestamp': self.current_state.get('timestamp', 0)
        }
    
    def _record_current_actions(self):
        """Record current state/actions during learning mode"""
        # This would be called when player inputs are detected
        # For now, just record state
        pass
    
    async def _check_emergency_reactions(self, game_status: GameStatus):
        """Check and execute emergency reactions (healing, etc.)"""
        current_time = asyncio.get_event_loop().time()
        
        # Prevent spamming - minimum interval between actions
        if current_time - self.last_action_time < 0.1:
            return
        
        # Critical HP - use SSA immediately
        if game_status.hp_percent < Settings.HP_CRITICAL_THRESHOLD:
            logger.warning("CRITICAL HP - Using emergency healing!")
            await self._use_item("stone skin amulet")
            self.last_action_time = current_time
            self.actions_per_second += 1
        
        # Low HP - use health potion
        elif game_status.is_low_hp:
            logger.info("Low HP - Using health potion")
            await self._use_health_potion()
            self.last_action_time = current_time
            self.actions_per_second += 1
        
        # Low Mana - use mana potion
        elif game_status.is_low_mana:
            logger.info("Low Mana - Using mana potion")
            await self._use_mana_potion()
            self.last_action_time = current_time
            self.actions_per_second += 1
    
    async def _parse_chat_commands(self, game_status: GameStatus):
        """Parse chat for agent commands"""
        if not game_status.chat_messages:
            return
        
        for message in game_status.chat_messages[-5:]:  # Check last 5 messages
            command = self.vision_engine.chat_reader.parse_command(message)
            
            if command:
                logger.info(f"Chat command detected: {command['command']}")
                
                if command['command'] == 'hunt_here':
                    # Set current location as hunting center
                    minimap_crop = self.vision_engine.get_minimap_crop()
                    # TODO: Process minimap and set hunting area
                    logger.info("Hunting area set to current location")
                
                elif command['command'] == 'refill':
                    # Start refill route
                    logger.info("Initiating refill route")
                    # TODO: Execute refill trajectory
                
                elif command['command'] == 'stop':
                    logger.info("Stop command received")
                    self._stop_event.set()
    
    async def _execute_behavior(self, game_status: GameStatus):
        """Execute learned behavior or default pattern"""
        # Try to execute learned behavior
        success = await self.learning_module.execute_learned_behavior(
            self.current_state,
            self._execute_action
        )
        
        if not success:
            # Fall back to default hunting pattern
            await self._default_hunt_pattern()
    
    async def _default_hunt_pattern(self):
        """Default hunting pattern when no learned behavior available"""
        # Simple WASD rotation for demonstration
        # In production, this would be more sophisticated
        pass
    
    async def _execute_action(self, event):
        """Execute a single action event"""
        # This would interface with the input handler module
        # For now, just log
        logger.debug(f"Executing action: {event.action_type} - {event.key_code}")
    
    async def _use_item(self, item_name: str):
        """Use a specific item"""
        logger.info(f"Using item: {item_name}")
        # TODO: Implement actual item usage via input handler
    
    async def _use_health_potion(self):
        """Use health potion"""
        logger.info("Using health potion")
        # TODO: Implement potion usage
    
    async def _use_mana_potion(self):
        """Use mana potion"""
        logger.info("Using mana potion")
        # TODO: Implement potion usage
    
    def _check_stuck_detection(self):
        """Detect if character is stuck and take corrective action"""
        current_pos = self.last_position
        
        if current_pos and self.last_position:
            if current_pos == self.last_position:
                self.stuck_timer += 1
                
                if self.stuck_timer > Settings.STUCK_DETECTION_SECONDS:
                    logger.warning("Character stuck detected! Recalculating path...")
                    # Record failure
                    self.learning_module.record_failure(
                        trajectory_info={'position': current_pos},
                        failure_reason='stuck_detected',
                        game_state=self.current_state.copy()
                    )
                    self.stuck_timer = 0
            else:
                self.stuck_timer = 0
        
        self.last_position = current_pos
    
    def get_status(self) -> Dict:
        """Get current engine status"""
        return {
            'is_running': self.is_running,
            'is_learning': self.learning_module.is_recording if self.learning_module else False,
            'current_state': self.current_state,
            'learning_stats': self.learning_module.get_learning_stats() if self.learning_module else {},
            'actions_per_second': self.actions_per_second
        }
