"""
Learning Module - Imitation Learning for Gameplay
==================================================
Records player actions during "Pilot Mode" and learns
movement patterns, routes, and decision sequences.
Supports playback and adaptation based on learned behavior.
"""

import json
import time
import pickle
import asyncio
from pathlib import Path
from typing import Dict, List, Tuple, Optional, Any
from dataclasses import dataclass, asdict
from datetime import datetime
import numpy as np

from config.settings import Settings
from utils.logger import setup_logger

logger = setup_logger('learning')


@dataclass
class ActionEvent:
    """Represents a single action event in the timeline"""
    timestamp: float  # Relative time from start of recording
    action_type: str  # 'key_press', 'key_release', 'mouse_move', 'mouse_click'
    key_code: Optional[str] = None  # e.g., 'W', 'A', 'S', 'D', '1', '2', etc.
    mouse_x: Optional[int] = None
    mouse_y: Optional[int] = None
    mouse_delta_x: Optional[float] = None
    mouse_delta_y: Optional[float] = None
    click_button: Optional[str] = None  # 'left', 'right', 'middle'
    context: Optional[Dict] = None  # Additional context (HP%, Mana%, position, etc.)
    
    def to_dict(self) -> Dict:
        return asdict(self)
    
    @classmethod
    def from_dict(cls, data: Dict) -> 'ActionEvent':
        return cls(**data)


@dataclass
class TrajectorySegment:
    """A segment of movement trajectory with associated metadata"""
    start_time: float
    end_time: float
    start_position: Tuple[int, int]  # Minimap coordinates
    end_position: Tuple[int, int]
    actions: List[ActionEvent]
    success: bool = True
    failure_reason: Optional[str] = None
    hp_average: float = 100.0
    mana_average: float = 100.0
    
    def to_dict(self) -> Dict:
        data = asdict(self)
        data['actions'] = [a.to_dict() for a in self.actions]
        return data
    
    @classmethod
    def from_dict(cls, data: Dict) -> 'TrajectorySegment':
        data['actions'] = [ActionEvent.from_dict(a) for a in data['actions']]
        return cls(**data)


@dataclass
class RecordingSession:
    """Complete recording session with all captured data"""
    session_id: str
    start_time: str
    end_time: Optional[str]
    character_name: str
    vocation: str
    total_duration: float
    events: List[ActionEvent]
    trajectories: List[TrajectorySegment]
    screenshots: List[str]  # Paths to saved screenshots
    minimap_frames: List[Dict]  # Minimap data at key moments
    metadata: Dict
    
    def to_dict(self) -> Dict:
        data = asdict(self)
        data['events'] = [e.to_dict() for e in self.events]
        data['trajectories'] = [t.to_dict() for t in self.trajectories]
        return data
    
    @classmethod
    def from_dict(cls, data: Dict) -> 'RecordingSession':
        data['events'] = [ActionEvent.from_dict(e) for e in data['events']]
        data['trajectories'] = [TrajectorySegment.from_dict(t) for t in data['trajectories']]
        return cls(**data)


class PilotRecorder:
    """Records player actions during pilot mode"""
    
    def __init__(self, output_dir: Path = None):
        self.output_dir = output_dir or Path(__file__).parent.parent / "data" / "recordings"
        self.output_dir.mkdir(parents=True, exist_ok=True)
        
        self.is_recording = False
        self.current_session: Optional[RecordingSession] = None
        self.event_buffer: List[ActionEvent] = []
        self.start_time = 0
        
        # Callbacks for capturing game state
        self.state_callback = None
        self.screenshot_callback = None
        
        # Timing
        self.last_event_time = 0
        self.min_event_interval = 0.015  # 15ms minimum between events
    
    def start_session(self, character_name: str = "Unknown", vocation: str = "Unknown") -> str:
        """
        Start a new recording session
        
        Args:
            character_name: Name of the character being recorded
            vocation: Character vocation
            
        Returns:
            Session ID
        """
        session_id = datetime.now().strftime("%Y%m%d_%H%M%S")
        
        self.current_session = RecordingSession(
            session_id=session_id,
            start_time=datetime.now().isoformat(),
            end_time=None,
            character_name=character_name,
            vocation=vocation,
            total_duration=0.0,
            events=[],
            trajectories=[],
            screenshots=[],
            minimap_frames=[],
            metadata={
                "client": "Rubinot",
                "version": "1.0",
                "recording_mode": "pilot"
            }
        )
        
        self.event_buffer = []
        self.start_time = time.time()
        self.is_recording = True
        self.last_event_time = self.start_time
        
        logger.info(f"Started recording session: {session_id}")
        logger.info(f"Character: {character_name} ({vocation})")
        
        return session_id
    
    def stop_session(self) -> Optional[str]:
        """
        Stop current recording session and save to disk
        
        Returns:
            Path to saved file or None if no session active
        """
        if not self.is_recording or not self.current_session:
            return None
        
        self.is_recording = False
        
        # Finalize session
        self.current_session.end_time = datetime.now().isoformat()
        self.current_session.total_duration = time.time() - self.start_time
        self.current_session.events = self.event_buffer.copy()
        
        # Process and extract trajectories
        self._extract_trajectories()
        
        # Save to disk
        file_path = self._save_session()
        
        logger.info(f"Recording session saved: {file_path}")
        logger.info(f"Total duration: {self.current_session.total_duration:.2f}s")
        logger.info(f"Total events: {len(self.current_session.events)}")
        logger.info(f"Extracted trajectories: {len(self.current_session.trajectories)}")
        
        session_id = self.current_session.session_id
        self.current_session = None
        self.event_buffer = []
        
        return file_path
    
    def record_action(
        self,
        action_type: str,
        key_code: str = None,
        mouse_x: int = None,
        mouse_y: int = None,
        mouse_delta_x: float = None,
        mouse_delta_y: float = None,
        click_button: str = None,
        context: Dict = None
    ):
        """
        Record a single action event
        
        Args:
            action_type: Type of action ('key_press', 'key_release', 'mouse_move', 'mouse_click')
            key_code: Key code for keyboard events
            mouse_x, mouse_y: Absolute mouse coordinates
            mouse_delta_x, mouse_delta_y: Relative mouse movement
            click_button: Mouse button for click events
            context: Additional context (game state)
        """
        if not self.is_recording:
            return
        
        current_time = time.time()
        
        # Enforce minimum interval to avoid excessive data
        if current_time - self.last_event_time < self.min_event_interval:
            return
        
        relative_timestamp = current_time - self.start_time
        
        event = ActionEvent(
            timestamp=relative_timestamp,
            action_type=action_type,
            key_code=key_code,
            mouse_x=mouse_x,
            mouse_y=mouse_y,
            mouse_delta_x=mouse_delta_x,
            mouse_delta_y=mouse_delta_y,
            click_button=click_button,
            context=context or {}
        )
        
        self.event_buffer.append(event)
        self.last_event_time = current_time
        
        # Capture periodic screenshots (every 30 seconds)
        if int(relative_timestamp) % 30 == 0 and self.screenshot_callback:
            try:
                screenshot_path = self.screenshot_callback(f"frame_{int(relative_timestamp)}.png")
                if screenshot_path:
                    self.current_session.screenshots.append(screenshot_path)
            except Exception as e:
                logger.debug(f"Screenshot capture skipped: {e}")
        
        # Capture minimap data periodically
        if int(relative_timestamp) % 5 == 0 and self.state_callback:
            try:
                minimap_data = self.state_callback()
                if minimap_data:
                    self.current_session.minimap_frames.append({
                        'timestamp': relative_timestamp,
                        'data': minimap_data
                    })
            except Exception as e:
                logger.debug(f"Minimap capture skipped: {e}")
    
    def _extract_trajectories(self):
        """Extract meaningful trajectory segments from event stream"""
        if not self.event_buffer:
            return
        
        trajectories = []
        current_segment_actions = []
        segment_start_time = None
        last_position = None
        
        for event in self.event_buffer:
            # Look for movement sequences (WASD keys)
            if event.action_type in ['key_press', 'key_release'] and event.key_code in ['W', 'A', 'S', 'D']:
                if segment_start_time is None:
                    segment_start_time = event.timestamp
                    current_segment_actions = []
                
                current_segment_actions.append(event)
                
                # Check if segment should end (gap in movement > 2 seconds)
                if len(current_segment_actions) > 1:
                    time_gap = event.timestamp - current_segment_actions[-2].timestamp
                    if time_gap > 2.0:
                        # End current segment
                        if len(current_segment_actions) >= 3:  # Minimum 3 actions
                            trajectory = self._create_trajectory(
                                segment_start_time,
                                event.timestamp,
                                current_segment_actions,
                                last_position
                            )
                            if trajectory:
                                trajectories.append(trajectory)
                        
                        # Start new segment
                        segment_start_time = event.timestamp
                        current_segment_actions = [event]
            
            # Track mouse positions for segment endpoints
            if event.mouse_x is not None and event.mouse_y is not None:
                last_position = (event.mouse_x, event.mouse_y)
        
        # Don't forget the last segment
        if current_segment_actions and segment_start_time:
            trajectory = self._create_trajectory(
                segment_start_time,
                current_segment_actions[-1].timestamp,
                current_segment_actions,
                last_position
            )
            if trajectory:
                trajectories.append(trajectory)
        
        self.current_session.trajectories = trajectories
        logger.info(f"Extracted {len(trajectories)} trajectory segments")
    
    def _create_trajectory(
        self,
        start_time: float,
        end_time: float,
        actions: List[ActionEvent],
        end_position: Optional[Tuple[int, int]]
    ) -> Optional[TrajectorySegment]:
        """Create a trajectory segment from action sequence"""
        if not actions:
            return None
        
        # Extract HP/Mana stats from context
        hp_values = []
        mana_values = []
        
        for action in actions:
            if action.context:
                if 'hp_percent' in action.context:
                    hp_values.append(action.context['hp_percent'])
                if 'mana_percent' in action.context:
                    mana_values.append(action.context['mana_percent'])
        
        hp_avg = np.mean(hp_values) if hp_values else 100.0
        mana_avg = np.mean(mana_values) if mana_values else 100.0
        
        # Estimate start position (would need actual minimap data in production)
        start_position = (0, 0)  # Placeholder
        if end_position is None:
            end_position = (0, 0)
        
        return TrajectorySegment(
            start_time=start_time,
            end_time=end_time,
            start_position=start_position,
            end_position=end_position,
            actions=actions,
            success=True,
            hp_average=hp_avg,
            mana_average=mana_avg
        )
    
    def _save_session(self) -> str:
        """Save session to disk"""
        if not self.current_session:
            return ""
        
        # Save as JSON
        file_path = self.output_dir / f"session_{self.current_session.session_id}.json"
        
        with open(file_path, 'w', encoding='utf-8') as f:
            json.dump(self.current_session.to_dict(), f, indent=2, ensure_ascii=False)
        
        # Also save pickle for faster loading
        pickle_path = self.output_dir / f"session_{self.current_session.session_id}.pkl"
        with open(pickle_path, 'wb') as f:
            pickle.dump(self.current_session.to_dict(), f)
        
        return str(file_path)


class TrajectoryPlayback:
    """Plays back recorded trajectories with human-like variations"""
    
    def __init__(self):
        self.recorded_sessions: Dict[str, RecordingSession] = {}
        self.playback_speed = 1.0
        self.human_noise_enabled = True
        
        # Load existing sessions
        self._load_saved_sessions()
    
    def _load_saved_sessions(self):
        """Load all saved recording sessions"""
        recordings_dir = Path(__file__).parent.parent / "data" / "recordings"
        
        if not recordings_dir.exists():
            return
        
        for file_path in recordings_dir.glob("session_*.json"):
            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    session = RecordingSession.from_dict(data)
                    self.recorded_sessions[session.session_id] = session
                    logger.info(f"Loaded session: {session.session_id}")
            except Exception as e:
                logger.error(f"Failed to load session {file_path}: {e}")
    
    def get_available_sessions(self) -> List[Dict]:
        """Get list of available recording sessions"""
        return [
            {
                'session_id': s.session_id,
                'character': s.character_name,
                'vocation': s.vocation,
                'duration': s.total_duration,
                'trajectories': len(s.trajectories),
                'start_time': s.start_time
            }
            for s in self.recorded_sessions.values()
        ]
    
    async def play_trajectory(
        self,
        session_id: str,
        trajectory_index: int = 0,
        action_callback=None
    ) -> bool:
        """
        Play back a specific trajectory from a recording
        
        Args:
            session_id: ID of the recording session
            trajectory_index: Index of trajectory to play
            action_callback: Async callback to execute actions
            
        Returns:
            True if playback successful
        """
        if session_id not in self.recorded_sessions:
            logger.error(f"Session not found: {session_id}")
            return False
        
        session = self.recorded_sessions[session_id]
        
        if trajectory_index >= len(session.trajectories):
            logger.error(f"Trajectory index out of range: {trajectory_index}")
            return False
        
        trajectory = session.trajectories[trajectory_index]
        logger.info(f"Playing trajectory {trajectory_index} from session {session_id}")
        
        start_time = time.time()
        
        for event in trajectory.actions:
            # Calculate delay with human noise
            delay = event.timestamp - (time.time() - start_time)
            
            if self.human_noise_enabled:
                delay = self._add_human_noise(delay)
            
            if delay > 0:
                await asyncio.sleep(delay / self.playback_speed)
            
            # Execute action via callback
            if action_callback:
                try:
                    await action_callback(event)
                except Exception as e:
                    logger.error(f"Action execution failed: {e}")
        
        logger.info("Trajectory playback completed")
        return True
    
    def _add_human_noise(self, base_delay: float) -> float:
        """
        Add human-like variations to timing
        
        Args:
            base_delay: Original delay from recording
            
        Returns:
            Modified delay with noise
        """
        if not self.human_noise_enabled:
            return base_delay
        
        # Add random variation between 45ms and 160ms
        noise = np.random.uniform(0.045, 0.160)
        
        # Slight speed variation (±5%)
        speed_var = np.random.uniform(-0.05, 0.05)
        
        modified_delay = base_delay * (1 + speed_var) + noise
        
        return max(modified_delay, 0.020)  # Minimum 20ms
    
    def find_similar_trajectory(
        self,
        current_position: Tuple[int, int],
        target_position: Tuple[int, int],
        tolerance: float = 50.0
    ) -> Optional[TrajectorySegment]:
        """
        Find a recorded trajectory similar to current situation
        
        Args:
            current_position: Current minimap coordinates
            target_position: Desired destination coordinates
            tolerance: Position matching tolerance in pixels
            
        Returns:
            Best matching trajectory or None
        """
        best_match = None
        best_score = float('inf')
        
        for session in self.recorded_sessions.values():
            for trajectory in session.trajectories:
                # Calculate distance score
                start_dist = np.sqrt(
                    (trajectory.start_position[0] - current_position[0])**2 +
                    (trajectory.start_position[1] - current_position[1])**2
                )
                
                end_dist = np.sqrt(
                    (trajectory.end_position[0] - target_position[0])**2 +
                    (trajectory.end_position[1] - target_position[1])**2
                )
                
                score = start_dist + end_dist
                
                if score < best_score and score < tolerance * 2:
                    best_score = score
                    best_match = trajectory
        
        if best_match:
            logger.info(f"Found similar trajectory (score: {best_score:.2f})")
        
        return best_match


class ImitationLearner:
    """Main learning module coordinating recording and playback"""
    
    def __init__(self):
        self.recorder = PilotRecorder()
        self.playback = TrajectoryPlayback()
        
        self.is_recording = False
        self.is_playing = False
        
        # Learning parameters
        self.confidence_threshold = 0.7
        self.adaptation_rate = 0.1
        
        # Failure memory
        self.failure_patterns: List[Dict] = []
    
    def start_recording(self, character_name: str = "Unknown", vocation: str = "Unknown"):
        """Start pilot recording mode"""
        if self.is_recording:
            logger.warning("Already recording")
            return
        
        self.recorder.start_session(character_name, vocation)
        self.is_recording = True
        logger.info("Pilot recording STARTED - Play naturally for 3-4 hours")
    
    def stop_recording(self) -> Optional[str]:
        """Stop pilot recording mode"""
        if not self.is_recording:
            return None
        
        file_path = self.recorder.stop_session()
        self.is_recording = False
        
        # Reload sessions to include new recording
        self.playback._load_saved_sessions()
        
        logger.info("Pilot recording STOPPED - Agent has learned from your gameplay")
        return file_path
    
    def register_action(self, **kwargs):
        """Register an action during recording"""
        if self.is_recording:
            self.recorder.record_action(**kwargs)
    
    def set_state_callback(self, callback):
        """Set callback for capturing game state during recording"""
        self.recorder.state_callback = callback
    
    def set_screenshot_callback(self, callback):
        """Set callback for capturing screenshots during recording"""
        self.recorder.screenshot_callback = callback
    
    async def execute_learned_behavior(
        self,
        current_state: Dict,
        action_callback
    ) -> bool:
        """
        Execute learned behavior based on current game state
        
        Args:
            current_state: Current game state (position, HP, Mana, etc.)
            action_callback: Callback to execute actions
            
        Returns:
            True if behavior executed successfully
        """
        # Find appropriate trajectory based on current state
        current_pos = current_state.get('position', (0, 0))
        target_pos = current_state.get('target_position', (0, 0))
        
        trajectory = self.playback.find_similar_trajectory(current_pos, target_pos)
        
        if trajectory:
            # Check if this trajectory has failure history
            if self._is_trajectory_safe(trajectory):
                return await self.playback.play_trajectory(
                    trajectory.session_id,
                    trajectory.index,
                    action_callback
                )
            else:
                logger.warning("Trajectory has failure history, seeking alternative")
        
        # No suitable trajectory found or unsafe
        logger.info("No learned behavior available for current state")
        return False
    
    def record_failure(
        self,
        trajectory_info: Dict,
        failure_reason: str,
        game_state: Dict
    ):
        """
        Record a failure to avoid repeating it
        
        Args:
            trajectory_info: Information about the failed trajectory
            failure_reason: Description of what went wrong
            game_state: Game state at time of failure
        """
        failure_record = {
            'timestamp': time.time(),
            'trajectory': trajectory_info,
            'reason': failure_reason,
            'game_state': game_state,
            'avoidance_weight': 1.0
        }
        
        self.failure_patterns.append(failure_record)
        
        # Keep only last 100 failures
        if len(self.failure_patterns) > 100:
            self.failure_patterns = self.failure_patterns[-100:]
        
        logger.warning(f"Failure recorded: {failure_reason}")
    
    def _is_trajectory_safe(self, trajectory: TrajectorySegment) -> bool:
        """Check if trajectory has low failure risk"""
        for failure in self.failure_patterns:
            # Simple proximity check (could be more sophisticated)
            if abs(failure['trajectory'].get('start_time', 0) - trajectory.start_time) < 5.0:
                if failure['avoidance_weight'] > 0.5:
                    return False
        
        return True
    
    def get_learning_stats(self) -> Dict:
        """Get statistics about learned behaviors"""
        sessions = self.playback.get_available_sessions()
        
        total_trajectories = sum(s['trajectories'] for s in sessions)
        total_duration = sum(s['duration'] for s in sessions)
        
        return {
            'sessions_count': len(sessions),
            'total_trajectories': total_trajectories,
            'total_learning_hours': total_duration / 3600,
            'failure_patterns': len(self.failure_patterns),
            'sessions': sessions
        }
