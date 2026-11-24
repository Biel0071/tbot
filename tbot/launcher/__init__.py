"""TBot Launcher — iniciador/atualizador independente do TBot.exe.

O Launcher NUNCA depende do aplicativo principal: ele apenas consulta o
TBot Update Server, baixa pacotes versionados, valida integridade (SHA256),
aplica atualizações transacionais com rollback e inicia o TBot.exe.
"""

__version__ = "1.0.0"
