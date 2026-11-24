"""
Utility module for detecting Rubinot game process
"""

import psutil
from typing import Optional, Dict, List
from utils.logger import setup_logger

logger = setup_logger('process_detector')


class ProcessDetector:
    """Detects and monitors Rubinot game process"""
    
    # Known process names for Rubinot/Tibia clients
    RUBINOT_PROCESS_NAMES = [
        'rubinot.exe',
        'rubinot',
        'tibia.exe',
        'tibia',
        'client.exe'
    ]
    
    def __init__(self):
        self.cached_process = None
    
    def find_rubinot_process(self) -> Optional[Dict]:
        """
        Search for running Rubinot process
        
        Returns:
            Dict with process info or None if not found
        """
        try:
            for proc in psutil.process_iter(['pid', 'name', 'exe']):
                try:
                    process_name = proc.info['name'].lower()
                    
                    for target_name in self.RUBINOT_PROCESS_NAMES:
                        if target_name in process_name:
                            process_info = {
                                'pid': proc.info['pid'],
                                'name': proc.info['name'],
                                'exe': proc.info['exe'],
                                'status': proc.status()
                            }
                            
                            self.cached_process = process_info
                            logger.info(f"Rubinot process detected: {process_info['name']} (PID: {process_info['pid']})")
                            return process_info
                            
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue
            
            self.cached_process = None
            return None
            
        except Exception as e:
            logger.error(f"Process detection failed: {e}")
            return None
    
    def is_process_running(self, pid: int) -> bool:
        """Check if a specific process is still running"""
        try:
            proc = psutil.Process(pid)
            return proc.is_running() and proc.status() != psutil.STATUS_ZOMBIE
        except psutil.NoSuchProcess:
            return False
        except Exception:
            return False
    
    def get_process_window_info(self, pid: int) -> Optional[Dict]:
        """
        Get window information for a process (Windows only)
        
        Returns:
            Dict with window handle and dimensions or None
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
            
            if windows:
                hwnd = windows[0]
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
            
            return None
            
        except ImportError:
            logger.warning("win32gui not available, window detection skipped")
            return None
        except Exception as e:
            logger.error(f"Window info detection failed: {e}")
            return None
    
    def get_all_game_processes(self) -> List[Dict]:
        """Get all potential game client processes"""
        game_processes = []
        
        try:
            for proc in psutil.process_iter(['pid', 'name', 'exe', 'memory_percent', 'cpu_percent']):
                try:
                    process_name = proc.info['name'].lower()
                    
                    # Check for game-related keywords
                    game_keywords = ['tibia', 'rubinot', 'game', 'client', 'otclient']
                    
                    if any(keyword in process_name for keyword in game_keywords):
                        game_processes.append({
                            'pid': proc.info['pid'],
                            'name': proc.info['name'],
                            'exe': proc.info.get('exe'),
                            'memory_percent': proc.info.get('memory_percent'),
                            'cpu_percent': proc.info.get('cpu_percent')
                        })
                        
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue
        
        except Exception as e:
            logger.error(f"Failed to enumerate processes: {e}")
        
        return game_processes
    
    def wait_for_process(self, timeout: float = 30.0) -> Optional[Dict]:
        """
        Wait for Rubinot process to start
        
        Args:
            timeout: Maximum time to wait in seconds
            
        Returns:
            Process info dict or None if timeout
        """
        import time
        
        start_time = time.time()
        
        while time.time() - start_time < timeout:
            process_info = self.find_rubinot_process()
            
            if process_info:
                return process_info
            
            time.sleep(0.5)
        
        logger.warning(f"Process not found within {timeout} seconds")
        return None
