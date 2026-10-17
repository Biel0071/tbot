"""
Vision Module - HP/Mana Reading and Item Detection
====================================================
High-speed screen capture and computer vision processing
for extracting game state information from Rubinot client.
"""

import cv2
import numpy as np
from typing import Dict, Tuple, Optional, List
from dataclasses import dataclass
import time
from pathlib import Path

try:
    import mss
    import mss.tools
except ImportError:
    mss = None

try:
    import pytesseract
except ImportError:
    pytesseract = None

from config.settings import Settings
from utils.logger import setup_logger

logger = setup_logger('vision')


@dataclass
class GameStatus:
    """Container for current game status extracted from vision"""
    hp_percent: float = 100.0
    mana_percent: float = 100.0
    hp_value: int = 0
    mana_value: int = 0
    inventory_items: Dict[str, int] = None
    is_low_hp: bool = False
    is_low_mana: bool = False
    minimap_data: Optional[dict] = None
    chat_messages: List[str] = None
    
    def __post_init__(self):
        if self.inventory_items is None:
            self.inventory_items = {}
        if self.chat_messages is None:
            self.chat_messages = []


class ScreenCapture:
    """High-speed screen capture using Windows Duplication API via mss"""
    
    def __init__(self, capture_area: Tuple[int, int, int, int] = None):
        """
        Initialize screen capture
        
        Args:
            capture_area: (left, top, width, height) or None for full screen
        """
        if mss is None:
            raise ImportError("mss library required for screen capture")
        
        self.sct = mss.mss()
        self.capture_area = capture_area
        self.last_capture_time = 0
        self.fps_counter = 0
        self.fps_start_time = time.time()
        
        # Monitor selection
        self.monitor = None
        if capture_area:
            self.monitor = {
                'left': capture_area[0],
                'top': capture_area[1],
                'width': capture_area[2],
                'height': capture_area[3]
            }
    
    def capture(self) -> Optional[np.ndarray]:
        """
        Capture screen and return as numpy array (BGR format for OpenCV)
        
        Returns:
            numpy array in BGR format or None if capture failed
        """
        try:
            if self.monitor:
                screenshot = self.sct.grab(self.monitor)
            else:
                # Capture primary monitor
                screenshot = self.sct.grab(self.sct.monitors[0])
            
            # Convert to numpy array
            img = np.array(screenshot)
            
            # Convert BGRA to BGR (OpenCV format)
            img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
            
            self.last_capture_time = time.time()
            self._update_fps()
            
            return img
            
        except Exception as e:
            logger.error(f"Screen capture failed: {e}")
            return None
    
    def _update_fps(self):
        """Update FPS counter"""
        self.fps_counter += 1
        elapsed = time.time() - self.fps_start_time
        if elapsed >= 1.0:
            logger.debug(f"Capture FPS: {self.fps_counter}")
            self.fps_counter = 0
            self.fps_start_time = time.time()
    
    def set_capture_area(self, left: int, top: int, width: int, height: int):
        """Set custom capture area"""
        self.capture_area = (left, top, width, height)
        self.monitor = {
            'left': left,
            'top': top,
            'width': width,
            'height': height
        }
        logger.info(f"Capture area set: {self.monitor}")


class HealthManaReader:
    """Extract HP and Mana percentages from game UI using pixel analysis"""
    
    def __init__(self):
        # Color ranges for HP bar (red) in HSV
        self.hp_color_lower = np.array([0, 100, 100])
        self.hp_color_upper = np.array([15, 255, 255])
        
        # Color ranges for Mana bar (blue) in HSV
        self.mana_color_lower = np.array([100, 100, 100])
        self.mana_color_upper = np.array([130, 255, 255])
        
        # Default positions (will be calibrated)
        self.hp_bar_position = None  # (x, y, width, height)
        self.mana_bar_position = None
        
        # Calibration templates
        self.hp_template = None
        self.mana_template = None
    
    def calibrate_positions(self, screenshot: np.ndarray) -> bool:
        """
        Auto-calibrate HP and Mana bar positions
        
        Args:
            screenshot: Full game screenshot
            
        Returns:
            True if calibration successful
        """
        try:
            # Convert to HSV for color detection
            hsv = cv2.cvtColor(screenshot, cv2.COLOR_BGR2HSV)
            
            # Detect red (HP bar)
            hp_mask = cv2.inRange(hsv, self.hp_color_lower, self.hp_color_upper)
            hp_contours, _ = cv2.findContours(hp_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            
            # Detect blue (Mana bar)
            mana_mask = cv2.inRange(hsv, self.mana_color_lower, self.mana_color_upper)
            mana_contours, _ = cv2.findContours(mana_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            
            # Find largest contours for each bar
            if hp_contours:
                hp_contour = max(hp_contours, key=cv2.contourArea)
                x, y, w, h = cv2.boundingRect(hp_contour)
                self.hp_bar_position = (x, y, w, h)
                logger.info(f"HP bar calibrated at: {self.hp_bar_position}")
            
            if mana_contours:
                mana_contour = max(mana_contours, key=cv2.contourArea)
                x, y, w, h = cv2.boundingRect(mana_contour)
                self.mana_bar_position = (x, y, w, h)
                logger.info(f"Mana bar calibrated at: {self.mana_bar_position}")
            
            return self.hp_bar_position is not None and self.mana_bar_position is not None
            
        except Exception as e:
            logger.error(f"Calibration failed: {e}")
            return False
    
    def read_hp_mana(self, screenshot: np.ndarray) -> Tuple[float, float]:
        """
        Read HP and Mana percentages from screenshot
        
        Args:
            screenshot: Game screenshot
            
        Returns:
            Tuple of (hp_percent, mana_percent)
        """
        hp_percent = 100.0
        mana_percent = 100.0
        
        try:
            hsv = cv2.cvtColor(screenshot, cv2.COLOR_BGR2HSV)
            
            # Read HP percentage
            if self.hp_bar_position:
                hp_percent = self._read_bar_percentage(
                    hsv, 
                    self.hp_bar_position, 
                    self.hp_color_lower, 
                    self.hp_color_upper
                )
            
            # Read Mana percentage
            if self.mana_bar_position:
                mana_percent = self._read_bar_percentage(
                    hsv, 
                    self.mana_bar_position, 
                    self.mana_color_lower, 
                    self.mana_color_upper
                )
            
            return hp_percent, mana_percent
            
        except Exception as e:
            logger.error(f"HP/Mana reading failed: {e}")
            return hp_percent, mana_percent
    
    def _read_bar_percentage(
        self, 
        hsv_image: np.ndarray, 
        position: Tuple[int, int, int, int],
        color_lower: np.ndarray,
        color_upper: np.ndarray
    ) -> float:
        """
        Calculate percentage of a status bar filled
        
        Args:
            hsv_image: Image in HSV format
            position: (x, y, width, height) of the bar
            color_lower: Lower HSV bound for color detection
            color_upper: Upper HSV bound for color detection
            
        Returns:
            Percentage filled (0-100)
        """
        x, y, w, h = position
        
        # Extract bar region
        bar_roi = hsv_image[y:y+h, x:x+w]
        
        # Create mask for colored portion
        mask = cv2.inRange(bar_roi, color_lower, color_upper)
        
        # Count non-zero pixels per column
        col_sums = np.sum(mask > 0, axis=0)
        
        # Find rightmost filled column
        filled_width = 0
        for i, sum_val in enumerate(col_sums):
            if sum_val > (h * 0.3):  # At least 30% of column height filled
                filled_width = i + 1
            else:
                break
        
        # Calculate percentage
        if w > 0:
            percentage = (filled_width / w) * 100
            return min(max(percentage, 0.0), 100.0)
        
        return 100.0


class InventoryReader:
    """OCR-based inventory item counting"""
    
    def __init__(self):
        self.item_templates = {}
        self.inventory_regions = []
        
        # Load item templates if available
        self._load_item_templates()
    
    def _load_item_templates(self):
        """Load item image templates for matching"""
        template_dir = Path(__file__).parent / "templates" / "items"
        
        if template_dir.exists():
            for template_file in template_dir.glob("*.png"):
                item_name = template_file.stem
                template = cv2.imread(str(template_file), cv2.IMREAD_GRAYSCALE)
                if template is not None:
                    self.item_templates[item_name] = template
                    logger.debug(f"Loaded template: {item_name}")
    
    def count_items(self, screenshot: np.ndarray) -> Dict[str, int]:
        """
        Count items in inventory using template matching and OCR
        
        Args:
            screenshot: Game screenshot
            
        Returns:
            Dictionary of item_name -> count
        """
        item_counts = {}
        
        try:
            gray = cv2.cvtColor(screenshot, cv2.COLOR_BGR2GRAY)
            
            # Template matching for known items
            for item_name, template in self.item_templates.items():
                count = self._count_template_matches(gray, template)
                if count > 0:
                    item_counts[item_name] = count
            
            # OCR for quantity text (if enabled)
            if pytesseract:
                text_regions = self._extract_text_regions(screenshot)
                quantities = self._parse_quantities(text_regions)
                
                # Merge with template counts
                for item, qty in quantities.items():
                    if item in item_counts:
                        item_counts[item] = max(item_counts[item], qty)
                    else:
                        item_counts[item] = qty
            
        except Exception as e:
            logger.error(f"Item counting failed: {e}")
        
        return item_counts
    
    def _count_template_matches(
        self, 
        image: np.ndarray, 
        template: np.ndarray,
        threshold: float = 0.8
    ) -> int:
        """Count occurrences of template in image"""
        if template.shape[0] > image.shape[0] or template.shape[1] > image.shape[1]:
            return 0
        
        result = cv2.matchTemplate(image, template, cv2.TM_CCOEFF_NORMED)
        matches = np.where(result >= threshold)
        
        # Non-maximum suppression to avoid duplicate counts
        count = 0
        matched_points = set()
        
        for pt in zip(*matches[::-1]):
            # Check if this point is far enough from existing matches
            is_new = True
            for existing in matched_points:
                dist = np.sqrt((pt[0]-existing[0])**2 + (pt[1]-existing[1])**2)
                if dist < 20:  # Within 20 pixels
                    is_new = False
                    break
            
            if is_new:
                count += 1
                matched_points.add(pt)
        
        return count
    
    def _extract_text_regions(self, screenshot: np.ndarray) -> List[np.ndarray]:
        """Extract regions containing text"""
        gray = cv2.cvtColor(screenshot, cv2.COLOR_BGR2GRAY)
        
        # Simple thresholding
        _, thresh = cv2.threshold(gray, 150, 255, cv2.THRESH_BINARY_INV)
        
        # Find contours
        contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        text_regions = []
        for contour in contours:
            x, y, w, h = cv2.boundingRect(contour)
            
            # Filter by size (likely text)
            if 20 <= w <= 200 and 10 <= h <= 50:
                roi = gray[y:y+h, x:x+w]
                text_regions.append(roi)
        
        return text_regions
    
    def _parse_quantities(self, text_regions: List[np.ndarray]) -> Dict[str, int]:
        """Parse quantity numbers from text regions"""
        quantities = {}
        
        if not pytesseract:
            return quantities
        
        for region in text_regions:
            try:
                text = pytesseract.image_to_string(region, config='--psm 7 digits')
                text = ''.join(filter(str.isdigit, text))
                
                if text:
                    # Assume it's a quantity
                    qty = int(text)
                    quantities["unknown"] = max(quantities.get("unknown", 0), qty)
            except:
                continue
        
        return quantities


class ChatReader:
    """Extract chat messages from game logs"""
    
    def __init__(self):
        self.chat_region = None  # (x, y, width, height)
        self.last_messages = []
        self.message_history = []
    
    def calibrate_chat_region(self, screenshot: np.ndarray) -> bool:
        """Auto-detect chat log region"""
        # Implementation depends on Rubinot UI layout
        # Default assumption: bottom-left corner
        height, width = screenshot.shape[:2]
        self.chat_region = (
            int(width * 0.05),
            int(height * 0.65),
            int(width * 0.35),
            int(height * 0.30)
        )
        return True
    
    def read_chat(self, screenshot: np.ndarray) -> List[str]:
        """Read recent chat messages"""
        messages = []
        
        if not self.chat_region or not pytesseract:
            return messages
        
        try:
            x, y, w, h = self.chat_region
            chat_roi = screenshot[y:y+h, x:x+w]
            
            # Preprocess for OCR
            gray = cv2.cvtColor(chat_roi, cv2.COLOR_BGR2GRAY)
            _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
            
            # OCR with line segmentation
            text = pytesseract.image_to_string(thresh, config='--psm 6')
            messages = [line.strip() for line in text.split('\n') if line.strip()]
            
            self.last_messages = messages
            self.message_history.extend(messages)
            
            # Keep only last 100 messages
            if len(self.message_history) > 100:
                self.message_history = self.message_history[-100:]
            
        except Exception as e:
            logger.error(f"Chat reading failed: {e}")
        
        return messages
    
    def parse_command(self, message: str) -> Optional[Dict]:
        """
        Parse agent commands from chat messages
        
        Expected format: "Agente, <command> [parameters]"
        Example: "Agente, up aqui"
        
        Returns:
            Dict with command info or None
        """
        if "agente" not in message.lower():
            return None
        
        message_lower = message.lower()
        
        # Command patterns
        if "up aqui" in message_lower:
            return {"command": "hunt_here", "priority": "high"}
        elif "voltar" in message_lower or "refill" in message_lower:
            return {"command": "refill", "priority": "high"}
        elif "treinar" in message_lower or "dummy" in message_lower:
            return {"command": "training", "priority": "medium"}
        elif "parar" in message_lower or "stop" in message_lower:
            return {"command": "stop", "priority": "critical"}
        
        return None


class VisionEngine:
    """Main vision engine coordinating all vision components"""
    
    def __init__(self, capture_area: Tuple[int, int, int, int] = None):
        self.capture = ScreenCapture(capture_area)
        self.hp_mana_reader = HealthManaReader()
        self.inventory_reader = InventoryReader()
        self.chat_reader = ChatReader()
        
        self.is_calibrated = False
        self.last_status = GameStatus()
        
        # Thresholds for alerts
        self.hp_threshold = Settings.HP_LOW_THRESHOLD
        self.mana_threshold = Settings.MANA_LOW_THRESHOLD
    
    def calibrate(self, screenshot: np.ndarray = None) -> bool:
        """
        Calibrate all vision components
        
        Args:
            screenshot: Optional screenshot for calibration
            
        Returns:
            True if calibration successful
        """
        try:
            if screenshot is None:
                screenshot = self.capture.capture()
            
            if screenshot is None:
                return False
            
            # Calibrate HP/Mana bars
            if not self.hp_mana_reader.calibrate_positions(screenshot):
                logger.warning("HP/Mana calibration incomplete")
            
            # Calibrate chat region
            self.chat_reader.calibrate_chat_region(screenshot)
            
            self.is_calibrated = True
            logger.info("Vision engine calibrated successfully")
            return True
            
        except Exception as e:
            logger.error(f"Vision calibration failed: {e}")
            return False
    
    def get_game_status(self) -> GameStatus:
        """
        Get current game status from latest capture
        
        Returns:
            GameStatus object with all extracted information
        """
        status = GameStatus()
        
        try:
            # Capture screen
            screenshot = self.capture.capture()
            if screenshot is None:
                return self.last_status
            
            # Read HP/Mana
            hp_percent, mana_percent = self.hp_mana_reader.read_hp_mana(screenshot)
            status.hp_percent = hp_percent
            status.mana_percent = mana_percent
            status.is_low_hp = hp_percent < self.hp_threshold
            status.is_low_mana = mana_percent < self.mana_threshold
            
            # Read inventory (less frequent, every few cycles)
            # status.inventory_items = self.inventory_reader.count_items(screenshot)
            
            # Read chat
            status.chat_messages = self.chat_reader.read_chat(screenshot)
            
            self.last_status = status
            
        except Exception as e:
            logger.error(f"Game status extraction failed: {e}")
        
        return status
    
    def get_minimap_crop(self, screenshot: np.ndarray = None) -> Optional[np.ndarray]:
        """Extract minimap region from screenshot"""
        if screenshot is None:
            screenshot = self.capture.capture()
        
        if screenshot is None:
            return None
        
        # Default minimap position (top-right corner, adjust based on Rubinot)
        height, width = screenshot.shape[:2]
        minimap_x = int(width * 0.75)
        minimap_y = int(height * 0.05)
        minimap_w = int(width * 0.20)
        minimap_h = int(height * 0.25)
        
        return screenshot[minimap_y:minimap_y+minimap_h, minimap_x:minimap_x+minimap_w]
