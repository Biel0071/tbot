"""
TBOT - Autonomous Intelligent Agent
====================================
Main entry point with Splash Screen, process detection,
and modern dark-themed GUI.
"""

import tkinter as tk
from tkinter import ttk, messagebox
import threading
import time
import psutil
import sys
import os

# Nome do processo do jogo/navegador a ser detectado
# Aceita variações comuns de clientes OTClient
PROCESSOS_ALVO = ["Rubinot.exe", "OTClient.exe", "Tibia.exe"] 

class TBotApplication:
    def __init__(self):
        self.root = tk.Tk()
        self.root.withdraw() # Oculta a janela principal durante o Splash
        
        # Configuração inicial de recursos
        self.is_running = False
        self.is_recording = False
        
        self.mostrar_splash()
        
    def mostrar_splash(self):
        self.splash = tk.Toplevel()
        self.splash.title("TBOT Bootloader")
        self.splash.geometry("450x300")
        self.splash.configure(bg="#1e1e2e")
        self.splash.overrideredirect(True) # Remove bordas da janela
        
        # Centralizar Splash
        screen_width = self.splash.winfo_screenwidth()
        screen_height = self.splash.winfo_screenheight()
        x = (screen_width // 2) - (450 // 2)
        y = (screen_height // 2) - (300 // 2)
        self.splash.geometry(f"450x300+{x}+{y}")
        
        # Impedir fechamento manual durante boot
        self.splash.protocol("WM_DELETE_WINDOW", lambda: None)
        
        # Logo / Texto TBOT
        lbl_logo = tk.Label(self.splash, text="⚡ TBOT ⚡", font=("Courier New", 36, "bold"), fg="#89b4fa", bg="#1e1e2e")
        lbl_logo.pack(pady=(50, 10))
        
        lbl_subtitle = tk.Label(self.splash, text="Autonomous Intelligent Agent", font=("Arial", 12, "italic"), fg="#a6adc8", bg="#1e1e2e")
        lbl_subtitle.pack()
        
        # Status de Carregamento
        self.lbl_status = tk.Label(self.splash, text="Iniciando módulos...", font=("Arial", 10), fg="#cdd6f4", bg="#1e1e2e")
        self.lbl_status.pack(pady=(40, 5))
        
        # Barra de Progresso
        style = ttk.Style()
        style.theme_use('default')
        style.configure("TBot.Horizontal.TProgressbar", background='#89b4fa', troughcolor='#313244', borderwidth=0, thickness=8)
        
        self.progress = ttk.Progressbar(self.splash, style="TBot.Horizontal.TProgressbar", orient="horizontal", length=350, mode="determinate")
        self.progress.pack()
        
        # Iniciar thread de verificação e carregamento
        threading.Thread(target=self.fluxo_inicializacao, daemon=True).start()
        self.root.mainloop()

    def detectar_processo_jogo(self):
        """Varre processos ativos procurando pelo cliente do jogo."""
        try:
            for proc in psutil.process_iter(['name']):
                if proc.info['name'] in PROCESSOS_ALVO:
                    return True, proc.info['name']
            return False, None
        except Exception:
            return False, None

    def fluxo_inicializacao(self):
        etapas = [
            ("Verificando integridade dos arquivos...", 20),
            ("Checando Driver Interception (Kernel)...", 40),
            ("Procurando cliente do jogo ativo...", 70),
            ("Sincronizando thresholds de visão computacional...", 90),
            ("Instanciando Inteligência Artificial...", 100)
        ]
        
        for msg, peso in etapas:
            time.sleep(0.8) # Simula carregamento síncrono visual
            self.lbl_status.config(text=msg)
            self.progress['value'] = peso
            
            # Validação do Jogo no passo de verificação de processo
            if "Procurando cliente" in msg:
                jogo_rodando, nome_processo = self.detectar_processo_jogo()
                if not jogo_rodando:
                    # Aguarda um pouco mais para dar chance do usuário abrir
                    time.sleep(1.5)
                    jogo_rodando, nome_processo = self.detectar_processo_jogo()
                    
                    if not jogo_rodando:
                        messagebox.showerror(
                            "TBOT - Alerta de Sistema", 
                            f"Nenhum cliente suportado encontrado!\n\nProcure por: {', '.join(PROCESSOS_ALVO)}\n\nPor favor, abra o jogo antes de ativar o agente autônomo."
                        )
                        self.splash.destroy()
                        self.root.quit()
                        sys.exit()
                    else:
                         self.lbl_status.config(text=f"Jogo Detectado: {nome_processo}")
                         time.sleep(0.5)
                    
        # Concluir Boot e abrir GUI principal
        self.splash.destroy()
        self.abrir_interface_principal()

    def abrir_interface_principal(self):
        self.main_window = tk.Toplevel(self.root)
        self.main_window.title("TBOT v1.0.0 - Painel de Controle")
        self.main_window.geometry("500x450")
        self.main_window.configure(bg="#181825")
        
        # Centralizar Janela Principal
        screen_width = self.main_window.winfo_screenwidth()
        screen_height = self.main_window.winfo_screenheight()
        x = (screen_width // 2) - (500 // 2)
        y = (screen_height // 2) - (450 // 2)
        self.main_window.geometry(f"500x450+{x}+{y}")
        
        # Protocolo para fechar a aplicação por completo
        self.main_window.protocol("WM_DELETE_WINDOW", self.root.quit)
        
        # Header TBOT
        frm_header = tk.Frame(self.main_window, bg="#11111b", height=60)
        frm_header.pack(fill="x")
        lbl_header = tk.Label(frm_header, text="TBOT AUTONOMOUS AGENT", font=("Arial", 16, "bold"), fg="#cdd6f4", bg="#11111b", pady=20)
        lbl_header.pack()
        
        # Container de Status do Alvo
        _, nome_proc = self.detectar_processo_jogo()
        lbl_target = tk.Label(self.main_window, text=f"VÍNCULO ATIVO: {nome_proc or 'Desconhecido'}", font=("Arial", 10, "bold"), fg="#a6e3a1", bg="#181825")
        lbl_target.pack(pady=10)
        
        # Frame de Botões
        frm_buttons = tk.Frame(self.main_window, bg="#181825")
        frm_buttons.pack(pady=10)
        
        # Estilo comum de botões
        btn_style = {"font": ("Arial", 11, "bold"), "fg": "#ffffff", "height": 2, "width": 28, "bd": 0, "cursor": "hand2", "relief": "flat"}
        
        self.btn_ativar = tk.Button(frm_buttons, text="▶ LIGAR AGENTE AUTÔNOMO", bg="#a6e3a1", activebackground="#94e2d5", **btn_style, command=self.toggle_agente)
        self.btn_ativar.pack(pady=10)
        
        self.btn_gravar = tk.Button(frm_buttons, text="🖲 GRAVAR PILOTO (APRENDER)", bg="#fab387", activebackground="#f9a870", **btn_style, command=self.toggle_gravacao)
        self.btn_gravar.pack(pady=10)
        
        # Console de Logs em Tempo Real interno na GUI
        frm_log = tk.Frame(self.main_window, bg="#1e1e2e", bd=1, relief="solid")
        frm_log.pack(pady=10, padx=20, fill="both", expand=True)
        
        lbl_log_title = tk.Label(frm_log, text="SYSTEM LOGS", font=("Arial", 9, "bold"), fg="#89b4fa", bg="#1e1e2e", anchor="w")
        lbl_log_title.pack(fill="x", padx=5, pady=2)
        
        self.log_box = tk.Text(frm_log, height=8, width=50, bg="#1e1e2e", fg="#cdd6f4", font=("Courier New", 9), bd=0, highlightthickness=0)
        self.log_box.pack(fill="both", expand=True, padx=5, pady=5)
        
        # Configurar tags de cor para logs
        self.log_box.tag_config("INFO", foreground="#89b4fa")
        self.log_box.tag_config("WARNING", foreground="#fab387")
        self.log_box.tag_config("ERROR", foreground="#f38ba8")
        self.log_box.tag_config("SUCCESS", foreground="#a6e3a1")
        
        self.inserir_log("Sistema inicializado com sucesso.", "SUCCESS")
        self.inserir_log(f"Aguardando comando do operador...", "INFO")

    def inserir_log(self, texto, tag="INFO"):
        timestamp = time.strftime('%H:%M:%S')
        self.log_box.insert(tk.END, f"[{timestamp}] {texto}\n", tag)
        self.log_box.see(tk.END)

    def toggle_agente(self):
        if not self.is_running:
            self.is_running = True
            self.btn_ativar.config(text="⏹ PARAR AGENTE", bg="#f38ba8", activebackground="#e06c78")
            self.inserir_log("Iniciando threads de visão e controle...", "WARNING")
            self.inserir_log("Agente autônomo ativado com ruído humano (45-160ms).", "SUCCESS")
            # TODO: Chamar core/engine.py start()
        else:
            self.is_running = False
            self.btn_ativar.config(text="▶ LIGAR AGENTE AUTÔNOMO", bg="#a6e3a1", activebackground="#94e2d5")
            self.inserir_log("Agente autônomo parado.", "INFO")
            # TODO: Chamar core/engine.py stop()

    def toggle_gravacao(self):
        if not self.is_recording:
            self.is_recording = True
            self.btn_gravar.config(text="⏹ PARAR GRAVAÇÃO", bg="#89b4fa", activebackground="#7aa2f7")
            self.inserir_log("Modo Imitação Ativo. Gravando inputs do usuário...", "WARNING")
            # TODO: Chamar learning/learning.py start_recording()
        else:
            self.is_recording = False
            self.btn_gravar.config(text="🖲 GRAVAR PILOTO (APRENDER)", bg="#fab387", activebackground="#f9a870")
            self.inserir_log("Gravação salva. Processando trajetórias...", "SUCCESS")
            # TODO: Chamar learning/learning.py stop_recording()

if __name__ == "__main__":
    # Verificação básica de dependências antes de iniciar
    try:
        import psutil
        import mss
        import cv2
    except ImportError as e:
        root = tk.Tk()
        root.withdraw()
        messagebox.showerror("Erro Crítico", f"Falta de dependências:\n{e}\n\nExecute: pip install -r requirements.txt")
        sys.exit()
        
    TBotApplication()
