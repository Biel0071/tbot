"""
Auto-calibration for game capture area
"""

from typing import Optional, Dict, Tuple
from utils.logger import setup_logger

logger = setup_logger('calibration')


class AutoCalibrator:
    """Automatically calibrates screen capture area for Rubinot client"""
    
    def __init__(self):
        self.capture_area: Optional[Tuple[int, int, int, int]] = None
        self.window_info: Optional[Dict] = None
    
    def calibrate(self, process_info: Dict) -> bool:
        """
        Calibrate capture area based on detected process
        
        Args:
            process_info: Process information from ProcessDetector
            
        Returns:
            True if calibration successful
        """
        try:
            pid = process_info.get('pid')
            
            if not pid:
                logger.error("No PID in process info")
                return False
            
            # Try to get window information
            window_info = self._get_window_bounds(pid)
            
            if window_info:
                self.window_info = window_info
                self.capture_area = (
                    window_info['left'],
                    window_info['top'],
                    window_info['width'],
                    window_info['height']
                )
                logger.info(f"Capture area calibrated: {self.capture_area}")
                return True
            else:
                # Fallback to default full-screen capture
                logger.warning("Window detection failed, using full screen")
                self.capture_area = None
                return True
                
        except Exception as e:
            logger.error(f"Calibration failed: {e}")
            return False
    
    def _get_window_bounds(self, pid: int) -> Optional[Dict]:
        """
        Get window bounds for a process (Windows only)
        
        Args:
            pid: Process ID
            
        Returns:
            Dict with window bounds or None
        """
        try:
            import win32gui
            import win32process
            
            def enum_windows_callback(hwnd, results):
                try:
                    _, proc_id = win32process.GetWindowThreadProcessId(hwnd)
                    if proc_id == pid and win32gui.IsWindowVisible(hwnd):
                        results.append(hwnd)
                except Exception:
                    pass
            
            windows = []
            win32gui.EnumWindows(enum_windows_callback, windows)
            
            if not windows:
                return None
            
            # Use the first visible window
            hwnd = windows[0]
            
            # Get window rectangle
            rect = win32gui.GetWindowRect(hwnd)
            
            return {
                'hwnd': hwnd,
                'left': rect[0],
                'top': rect[1],
                'right': rect[2],
                'bottom': rect[3],
                'width': rect[2] - rect[0],
                'height': rect[3] - rect[1]
            }
            
        except ImportError:
            # On Linux/Mac, return screen dimensions
            logger.debug("win32gui not available")
            return None
        except Exception as e:
            logger.error(f"Window bounds detection failed: {e}")
            return None
    
    def get_capture_area(self) -> Optional[Tuple[int, int, int, int]]:
        """Get the calibrated capture area"""
        return self.capture_area
    
    def recalibrate(self, process_info: Dict) -> bool:
        """Force recalibration"""
        self.capture_area = None
        self.window_info = None
        return self.calibrate(process_info)
    
    def adjust_capture_area(
        self, 
        left_offset: int = 0, 
        top_offset: int = 0,
        width_adjust: int = 0,
        height_adjust: int = 0
    ) -> Tuple[int, int, int, int]:
        """
        Adjust capture area with offsets
        
        Args:
            left_offset: Offset for left coordinate
            top_offset: Offset for top coordinate
            width_adjust: Adjustment for width
            height_adjust: Adjustment for height
            
        Returns:
            Adjusted capture area tuple
        """
        if not self.capture_area:
            return (0, 0, 1920, 1080)  # Default Full HD
        
        left, top, width, height = self.capture_area
        
        adjusted = (
            max(0, left + left_offset),
            max(0, top + top_offset),
            max(100, width + width_adjust),
            max(100, height + height_adjust)
        )
        
        self.capture_area = adjusted
        logger.info(f"Capture area adjusted: {adjusted}")
        
        return adjusted
