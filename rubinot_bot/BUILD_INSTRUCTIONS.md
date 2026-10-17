# TBOT - Instruções de Build e Distribuição

## 📦 Pré-requisitos

### 1. Python e Dependências
```bash
# Instale Python 3.8+ do site oficial: https://www.python.org/downloads/
pip install -r requirements.txt
```

### 2. Driver Interception (Nível Kernel)
O driver Interception é necessário para emulação de mouse/teclado indetectável.

**Download:** https://github.com/oblitum/Interception/releases

**Instalação:**
1. Baixe o `Interception.zip` mais recente
2. Extraia e execute `install-interception.exe` como Administrador
3. Reinicie o computador se solicitado

### 3. Tesseract OCR (Opcional, para leitura de inventário)
**Download:** https://github.com/UB-Mannheim/tesseract/wiki

**Instalação:**
```bash
# Instale no diretório padrão: C:\Program Files\Tesseract-OCR
# Adicione ao PATH durante a instalação
pip install pytesseract
```

---

## 🔨 Gerando o Executável

### Opção A: PyInstaller (Recomendado)

```bash
# No diretório raiz do projeto (rubinot_bot/)
pyinstaller --name="TBOT" ^
            --noconfirm ^
            --windowed ^
            --onedir ^
            --icon=utils/icon.ico ^
            --add-data "config;config" ^
            --add-data "core;core" ^
            --add-data "vision;vision" ^
            --add-data "learning;learning" ^
            --add-data "utils;utils" ^
            --hidden-import=psutil ^
            --hidden-import=mss ^
            --hidden-import=cv2 ^
            main.py
```

**Resultado:** `dist/TBOT/TBOT.exe`

### Opção B: Nuitka (Performance Superior)

```bash
pip install nuitka
python -m nuitka --mingw64 ^
       --standalone ^
       --enable-plugin=tk-inter ^
       --include-package=psutil ^
       --include-package=mss ^
       --include-package=cv2 ^
       --output-dir=dist ^
       main.py
```

---

## 📁 Estrutura Final para Distribuição

```
dist/TBOT/
├── TBOT.exe                    # Executável principal
├── python39.dll               # DLLs do Python
├── _internal/                 # Módulos internos
│   ├── config/
│   ├── core/
│   ├── vision/
│   ├── learning/
│   └── utils/
├── utils/
│   ├── interception_installer.exe  # Instalador do driver
│   └── icon.ico
└── README_INSTALL.txt         # Instruções para o usuário
```

---

## 🚀 Criando Instalador com Inno Setup

### 1. Instale o Inno Setup
**Download:** https://jrsoftware.org/isdl.php

### 2. Script `installer.iss`

Crie um arquivo `installer.iss` com o seguinte conteúdo:

```pascal
[Setup]
AppName=TBOT Autonomous Bot
AppVersion=1.0.0
DefaultDirName={autopf}\TBOT
DefaultGroupName=TBOT
OutputBaseFilename=Setup_TBOT_Pro_v1.0
Compression=lzma
SolidCompression=yes
PrivilegesRequired=admin
SetupIconFile=utils\icon.ico

[Files]
; Copia todos os arquivos do build PyInstaller
Source: "dist\TBOT\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\TBOT"; Filename: "{app}\TBOT.exe"
Name: "{autodesktop}\TBOT"; Filename: "{app}\TBOT.exe"

[Run]
; Instala o driver Interception silenciosamente
Filename: "{app}\utils\interception_installer.exe"; Parameters: "/install"; Flags: runhidden waituntilterminated

; Lança o TBOT após instalação
Filename: "{app}\TBOT.exe"; Description: "Lançar TBOT agora"; Flags: nowait postinstall skipifsilent
```

### 3. Compile o Instalador

1. Abra o Inno Setup Compiler
2. Carregue `installer.iss`
3. Pressione **F9** para compilar
4. Resultado: `Output/Setup_TBOT_Pro_v1.0.exe`

---

## 🎯 Fluxo de Uso para o Usuário Final

1. **Execute o instalador** `Setup_TBOT_Pro_v1.0.exe`
2. **Aceite os termos** e escolha o diretório de instalação
3. **O driver Interception será instalado** automaticamente
4. **TBOT será lançado** automaticamente após a instalação

### Ao abrir o TBOT:

1. **Splash Screen** aparece com animação de carregamento
2. **Verificação automática** do processo do jogo (Rubinot.exe, OTClient.exe, Tibia.exe)
3. **Se o jogo não estiver aberto:** Alerta é exibido pedindo para abrir o cliente
4. **GUI Principal** é liberada com:
   - Status do vínculo com o jogo
   - Botão **[LIGAR AGENTE AUTÔNOMO]**
   - Botão **[GRAVAR PILOTO (APRENDER)]**
   - Console de logs em tempo real

---

## ⚙️ Configurações Avançadas

### Thresholds de HP/Mana (config/settings.py)

```python
HP_EMERGENCY_THRESHOLD = 30  # Usa SSA quando HP < 30%
MANA_EMERGENCY_THRESHOLD = 20  # Usa Might Ring quando Mana < 20%
MIN_POTIONS_REFILL = 5  # Vai para refill quando poções <= 5
STUCK_TIMEOUT_SECONDS = 5.0  # Recalcula rota se travado por 5s
```

### Ruído Humano (inputs/input_emulator.py)

```python
MOUSE_JITTER_RANGE = 3  # Pixels de variação aleatória
CLICK_DELAY_MIN_MS = 45  # Delay mínimo entre ações
CLICK_DELAY_MAX_MS = 160  # Delay máximo entre ações
```

---

## 🛡️ Notas de Segurança

1. **Uso Educacional:** Este software é destinado para fins educacionais e de pesquisa em Visão Computacional e IA.
2. **ToS de Servidores:** O uso em servidores de Tibia/OTServ pode violar os Termos de Serviço. Use por sua conta e risco.
3. **Detecção:** O driver Interception opera em nível de kernel, tornando a detecção extremamente difícil, mas não impossível.
4. **Responsabilidade:** O usuário é responsável pelo uso ético e legal desta ferramenta.

---

## 📞 Suporte

Para issues técnicos, abra uma issue no repositório ou consulte a documentação em `docs/`.

**Versão:** 1.0.0  
**Última Atualização:** 2024
