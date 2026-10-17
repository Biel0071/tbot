# 🚀 TBOT - Guia de Início Rápido

## Visão Geral

O **TBOT** é um agente autônomo inteligente para Rubinot (OTServ) com:
- ✅ Captura de tela ultrarrápida via mss
- ✅ Leitura de HP/Mana em tempo real (OpenCV + HSV)
- ✅ Gravação de Piloto (Imitation Learning)
- ✅ Emulação de input via driver Interception (Kernel-level)
- ✅ Detecção automática de processo do jogo
- ✅ Interface GUI moderna com Splash Screen

---

## 📋 Pré-requisitos (Windows)

1. **Python 3.8+**: https://www.python.org/downloads/
2. **Git** (opcional, para clonar o repo): https://git-scm.com/

---

## 🔧 Instalação Passo a Passo

### Passo 1: Instalar Dependências Python

```bash
cd rubinot_bot
pip install -r requirements.txt
```

**requirements.txt inclui:**
```
opencv-python>=4.5.0
mss>=9.0.0
numpy>=1.21.0
psutil>=5.8.0
pytesseract>=0.3.0  # Opcional (OCR)
```

### Passo 2: Instalar Driver Interception

1. Baixe em: https://github.com/oblitum/Interception/releases
2. Extraia e execute `install-interception.exe` como **Administrador**
3. Reinicie o PC se solicitado

### Passo 3: Instalar Tesseract OCR (Opcional)

Para leitura de inventário via OCR:

1. Download: https://github.com/UB-Mannheim/tesseract/wiki
2. Instale em `C:\Program Files\Tesseract-OCR`
3. Marque "Adicionar ao PATH" durante instalação

---

## ▶️ Executando o TBOT

### Modo Desenvolvimento (Python)

```bash
python main.py
```

### O que acontece ao iniciar:

1. **Splash Screen** aparece (3-4 segundos)
   - Verifica arquivos
   - Checa driver Interception
   - **Procura processo do jogo** (Rubinot.exe, OTClient.exe, Tibia.exe)
   - Carrega módulos de visão e IA

2. **Se o jogo NÃO estiver aberto:**
   - ⚠️ Alerta é exibido
   - Aplicação fecha
   - **Solução:** Abra o Rubinot/OTClient e execute novamente

3. **GUI Principal é liberada:**
   - Status do vínculo com o jogo
   - Botão **[▶ LIGAR AGENTE AUTÔNOMO]**
   - Botão **[🖲 GRAVAR PILOTO (APRENDER)]**
   - Console de logs em tempo real

---

## 🎮 Usando o TBOT

### Modo 1: Agente Autônomo

1. Clique em **"LIGAR AGENTE AUTÔNOMO"**
2. O bot começa a:
   - Capturar tela (60+ FPS)
   - Ler HP/Mana constantemente
   - Usar SSA/Might Ring se HP/Mana baixos
   - Seguir rotas aprendidas (se houver gravação)
   - Reagir a comandos de chat ("Agente, up aqui")

3. Para parar: clique em **"⏹ PARAR AGENTE"**

### Modo 2: Gravar Piloto (Imitation Learning)

1. **Pare o agente** se estiver rodando
2. Clique em **"GRAVAR PILOTO (APRENDER)"**
3. **Jogue normalmente por 3-4 horas:**
   - Vá da Hunt para a cidade
   - Faça refill no NPC
   - Treine nos dummies
   - Volte para hunt
4. Clique em **"PARAR GRAVAÇÃO"**
5. O TBOT processa e salva as trajetórias

**Resultado:** O agente agora sabe replicar suas rotas!

---

## ⚙️ Configurações Padrão

Editáveis em `config/settings.py`:

```python
HP_EMERGENCY_THRESHOLD = 30    # Usa SSA quando HP < 30%
MANA_EMERGENCY_THRESHOLD = 20  # Usa Might Ring quando Mana < 20%
MIN_POTIONS_REFILL = 5         # Vai para refill quando poções <= 5
STUCK_TIMEOUT_SECONDS = 5.0    # Recalcula rota se travado por 5s

# Ruído Humano (anti-ban)
MOUSE_JITTER_RANGE = 3         # Pixels de variação aleatória
CLICK_DELAY_MIN_MS = 45        # Delay mínimo entre ações
CLICK_DELAY_MAX_MS = 160       # Delay máximo entre ações
```

---

## 🛠️ Gerando Executável (.exe)

### Com PyInstaller:

```bash
pip install pyinstaller
pyinstaller --name="TBOT" --noconfirm --windowed --onedir ^
            --add-data "config;config" ^
            --add-data "core;core" ^
            --add-data "vision;vision" ^
            --add-data "learning;learning" ^
            --add-data "utils;utils" ^
            main.py
```

**Resultado:** `dist/TBOT/TBOT.exe`

---

## 📦 Criando Instalador Profissional

### Com Inno Setup:

1. Instale Inno Setup: https://jrsoftware.org/isdl.php
2. Use o script `installer.iss` incluso
3. Compile (F9) → `Setup_TBOT_Pro_v1.0.exe`

Veja detalhes em `BUILD_INSTRUCTIONS.md`.

---

## 🐛 Troubleshooting

| Problema | Solução |
|----------|---------|
| "mss library required" | `pip install mss` |
| "cv2 not found" | `pip install opencv-python` |
| Jogo não detectado | Verifique se o nome do processo está em `PROCESSOS_ALVO` no `main.py` |
| Input não funciona | Reinstale driver Interception como Admin |
| OCR não lê itens | Instale Tesseract e adicione ao PATH |

---

## 📞 Suporte

- **Documentação completa:** `README.md`
- **Build e distribuição:** `BUILD_INSTRUCTIONS.md`
- **Arquitetura:** `PROJECT_STRUCTURE.md`

---

**Versão:** 1.0.0  
**Licença:** Uso educacional  
**⚠️ Aviso:** Pode violar ToS de servidores. Use por sua conta e risco.
