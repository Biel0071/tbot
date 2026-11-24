"""Interface gráfica do TBot Launcher (Tkinter, tema dark Catppuccin).

O Launcher possui UI própria e minimalista: status da versão, botão
ATUALIZAR, INICIAR, REPARAR e ROLLBACK. Não importa nenhum módulo do
aplicativo principal — continua funcional mesmo com o TBot quebrado.
"""

from __future__ import annotations

import threading
import tkinter as tk
from tkinter import ttk, messagebox

BG = "#1e1e2e"
FG = "#cdd6f4"
ACCENT = "#89b4fa"
GREEN = "#a6e3a1"
RED = "#f38ba8"


class LauncherUI:
    def __init__(self, controller):
        self.c = controller
        self.root = tk.Tk()
        self.root.title("TBot Launcher")
        self.root.geometry("480x340")
        self.root.configure(bg=BG)
        self.root.resizable(False, False)

        tk.Label(self.root, text="⚡ TBOT LAUNCHER", font=("Courier New", 20, "bold"),
                 fg=ACCENT, bg=BG).pack(pady=(18, 4))
        self.lbl_versions = tk.Label(self.root, text="", font=("Arial", 11), fg=FG, bg=BG)
        self.lbl_versions.pack(pady=4)
        self.lbl_status = tk.Label(self.root, text="Pronto.", font=("Arial", 10),
                                   fg="#a6adc8", bg=BG, wraplength=440, justify="left")
        self.lbl_status.pack(pady=6)

        self.progress = ttk.Progressbar(self.root, length=420, mode="determinate")
        self.progress.pack(pady=4)

        style = ttk.Style()
        style.theme_use("clam")
        style.configure("TButton", font=("Arial", 10, "bold"), padding=8)

        btns = tk.Frame(self.root, bg=BG)
        btns.pack(pady=14)
        self.btn_update = ttk.Button(btns, text="ATUALIZAR AGORA", command=self._on_update)
        self.btn_update.grid(row=0, column=0, padx=6)
        self.btn_launch = ttk.Button(btns, text="INICIAR TBOT", command=self._on_launch)
        self.btn_launch.grid(row=0, column=1, padx=6)
        self.btn_repair = ttk.Button(btns, text="REPARAR", command=self._on_repair)
        self.btn_repair.grid(row=1, column=0, pady=6, padx=6)
        self.btn_rollback = ttk.Button(btns, text="ROLLBACK", command=self._on_rollback)
        self.btn_rollback.grid(row=1, column=1, pady=6, padx=6)

        self.refresh()

    # ------------- helpers -------------
    def set_status(self, text: str, color: str = "#a6adc8") -> None:
        self.root.after(0, lambda: self.lbl_status.config(text=text, fg=color))

    def set_progress(self, value: float) -> None:
        self.root.after(0, lambda: self.progress.config(value=value))

    def refresh(self) -> None:
        active = self.c.vm.active_version() or "nenhuma"
        latest = self.c.latest_known or "?"
        self.lbl_versions.config(
            text=f"Instalada: v{active}   |   Servidor: v{latest}")

    def _run_bg(self, fn, done_msg: str, ok_color: str = GREEN) -> None:
        def worker():
            try:
                fn()
                self.set_status(done_msg, ok_color)
            except Exception as e:  # noqa: BLE001
                self.set_status(f"Erro: {e}", RED)
                self.root.after(0, lambda: messagebox.showerror("TBot Launcher", str(e)))
            finally:
                self.root.after(0, self.refresh)
                self.root.after(0, lambda: self.btn_update.config(state="normal"))
        self.btn_update.config(state="disabled")
        threading.Thread(target=worker, daemon=True).start()

    # ------------- ações -------------
    def _on_update(self):
        self._run_bg(lambda: self.c.update_now(), "Atualização concluída com sucesso.")

    def _on_launch(self):
        try:
            self.c.launch_app()
            self.set_status("TBot iniciado.", GREEN)
        except Exception as e:  # noqa: BLE001
            messagebox.showerror("TBot Launcher", f"Falha ao iniciar:\n{e}")

    def _on_repair(self):
        self._run_bg(lambda: self.c.repair(), "Reparação concluída.")

    def _on_rollback(self):
        if not messagebox.askyesno("TBot Launcher",
                                   "Restaurar a versão anterior? Esta ação é imediata."):
            return
        self._run_bg(lambda: self.c.do_rollback(), "Rollback aplicado com sucesso.")

    def run(self) -> int:
        self.root.mainloop()
        return 0
