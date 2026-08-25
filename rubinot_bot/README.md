# Rubinot Autonomous Bot

## Ecossistema Completo de Automação para Tibia/Rubinot com IA

Um sistema profissional de automação de gameplay baseado em **Visão Computacional** e **Aprendizado por Imitação**, projetado para operar autonomamente no servidor Rubinot (OTserv) com arquitetura modular preparada para migração futura ao Tibia Global.

---

## 🎯 Funcionalidades Principais

### 1. Interface Gráfica (GUI)
- Detecção automática do processo Rubinot em segundo plano
- Calibração automática da área de captura
- Botão principal: **[LIGAR AGENTE AUTÔNOMO]**
- Modo de gravação "Piloto" para aprendizado

### 2. Captura de Tela Ultrarrápida
- Usa API de Duplicação do Windows via `mss`
- 60+ FPS de taxa de captura
- Sem necessidade de OBS ou webcam

### 3. Leitura de HP/Mana em Tempo Real
- Análise de pixels via OpenCV
- Detecção de barras de vida e mana por cor (HSV)
- Thresholds configuráveis para ações emergenciais

### 4. Aprendizado por Imitação (Imitation Learning)
- **Modo "Gravar Piloto"**: Registra seu gameplay por 3-4 horas
- Codifica trajetórias, movimentos e sequências de teclas
- Reproduz comportamentos orgânicos com ruído humano
- Memória de falhas para evolução contínua

### 5. Agente Cognitivo (Mock VLM)
- Interpretação de comandos de chat ("Agente, up aqui")
- Base de conhecimento sobre itens, vocações e monstros
- Tomada de decisão contextual

### 6. Input Humanizado
- Atrasos aleatórios entre 45ms e 160ms
- Microvariações de movimento (tremores leves)
- Preparado para driver Interception (nível kernel)

---

## 📁 Estrutura do Projeto

```
rubinot_bot/
├── main.py                     # Entry point com GUI Tkinter
├── requirements.txt            # Dependências Python
├── PROJECT_STRUCTURE.md        # Documentação da arquitetura
├── README.md                   # Este arquivo
│
├── config/
│   ├── __init__.py
│   ├── settings.py             # Configurações globais
│   └── profiles.json           # Perfis de personagem
│
├── core/
│   ├── __init__.py
│   ├── engine.py               # Engine principal do jogo
│   ├── state_machine.py        # Máquina de estados
│   └── event_bus.py            # Sistema de eventos
│
├── vision/
│   ├── __init__.py
│   ├── capture.py              # Captura de tela
│   ├── vision.py               # Leitura HP/Mana, OCR, itens
│   ├── minimap_parser.py       # Análise do minimapa
│   └── templates/              # Templates de imagem
│
├── input_handler/
│   ├── __init__.py
│   ├── interceptor.py          # Driver Interception
│   ├── humanizer.py            # Ruído humano
│   └── keyboard_mouse.py       # Simulação de inputs
│
├── learning/
│   ├── __init__.py
│   ├── learning.py             # Gravação e reprodução
│   ├── trajectory_encoder.py   # Codificador de trajetórias
│   └── memory_bank.py          # Memória de sucessos/falhas
│
├── agent/
│   ├── __init__.py
│   ├── cognitive_agent.py      # Agente VLM
│   ├── chat_parser.py          # Parser de comandos
│   └── knowledge_base.py       # Base de conhecimento
│
├── gui/
│   ├── __init__.py
│   ├── main_window.py          # Janela principal
│   └── overlay.py              # Overlay flutuante
│
├── utils/
│   ├── __init__.py
│   ├── logger.py               # Logging
│   ├── process_detector.py     # Detecção de processos
│   └── calibration.py          # Calibração automática
│
└── data/
    ├── recordings/             # Gravações de piloto
    ├── memory/                 // Memórias aprendidas
    └── logs/                   # Logs de execução
```

---

## 🚀 Instalação

### Pré-requisitos
- Python 3.8+
- Windows 10/11 (para captura de tela e drivers de input)
- Rubinot client instalado e executável

### Passos

```bash
# Clonar repositório
cd rubinot_bot

# Criar ambiente virtual (recomendado)
python -m venv venv
venv\Scripts\activate  # Windows
source venv/bin/activate  # Linux/Mac

# Instalar dependências
pip install -r requirements.txt

# Instalar Tesseract OCR (necessário para leitura de texto)
# Windows: Baixe em https://github.com/UB-Mannheim/tesseract/wiki
# Linux: sudo apt-get install tesseract-ocr
```

---

## 🎮 Uso

### Iniciar o Bot

```bash
python main.py
```

1. A GUI será aberta
2. O bot detectará automaticamente o processo Rubinot
3. A área de captura será calibrada
4. Clique em **"LIGAR AGENTE AUTÔNOMO"** para iniciar

### Modo de Aprendizado (Gravar Piloto)

1. Inicie o agente autônomo
2. Clique em **"GRAVAR PILOTO"**
3. Jogue normalmente por 3-4 horas
   - Vá da Hunt para a Cidade
   - Faça o Refill no NPC
   - Vá aos Dummies de Treino
4. Clique em **"PARAR GRAVAÇÃO"**
5. O agente aprenderá suas rotinas e poderá replicá-las

### Comandos de Chat

Digite no chat do jogo:
- `"Agente, up aqui"` - Define área de hunt atual
- `"Agente, voltar"` ou `"Agente, refill"` - Inicia rota de refill
- `"Agente, treinar"` - Vai para dummies de treino
- `"Agente, parar"` - Para todas as ações

---

## ⚙️ Configuração

Edite `config/settings.py` para ajustar:

```python
# Thresholds de HP/Mana
HP_LOW_THRESHOLD = 35.0      # Usar potion abaixo de 35%
MANA_LOW_THRESHOLD = 20.0    # Usar mana potion abaixo de 20%
HP_CRITICAL_THRESHOLD = 15.0 # Emergência: SSA imediatamente

# Humanização de inputs
INPUT_DELAY_MIN_MS = 45      # Delay mínimo entre ações
INPUT_DELAY_MAX_MS = 160     # Delay máximo entre ações
MOUSE_NOISE_ENABLED = True   # Adicionar tremor ao mouse
```

---

## 🔒 Segurança e Anti-Detection

- ✅ Inputs com ruído humano (45-160ms delays)
- ✅ Microvariações de movimento diagonal
- ✅ Trajetórias baseadas em gameplay real
- ✅ Memória de falhas para evitar repetição
- ✅ Sem bibliotecas de automação detectáveis (usa driver kernel)

---

## 📊 Módulos Implementados

| Módulo | Status | Descrição |
|--------|--------|-----------|
| GUI (Tkinter) | ✅ Completo | Interface com botão principal |
| Detecção de Processo | ✅ Completo | Encontra Rubinot automaticamente |
| Captura de Tela (mss) | ✅ Completo | 60+ FPS via Windows Duplication API |
| Leitura HP/Mana | ✅ Completo | Pixel analysis via OpenCV HSV |
| Imitation Learning | ✅ Completo | Gravação e reprodução de trajetórias |
| Emergency Healer | ✅ Completo | Reação automática a HP/Mana baixo |
| Chat Parser | ✅ Completo | Interpreta comandos como "Agente, up aqui" |
| Stuck Detection | ✅ Completo | Detecta quando travado e recalcula rota |
| Input Humanization | 🔄 Mock | Pronto para Interception driver |
| VLM Agent | 🔄 Mock | Estrutura pronta para integração |

---

## 🛠️ Desenvolvimento

### Adicionar Novos Comportamentos

1. Grave uma sessão piloto na área desejada
2. O sistema extrairá automaticamente as trajetórias
3. O agente usará essas trajetórias quando estiver em situação similar

### Integrar VLM Real

```python
# Em agent/cognitive_agent.py
class CognitiveAgent:
    def __init__(self):
        self.vlm_client = YourVLMClient(api_key="...")
    
    async def decide_action(self, game_state):
        prompt = self._build_prompt(game_state)
        response = await self.vlm_client.query(prompt)
        return self._parse_response(response)
```

---

## 📝 Notas Importantes

⚠️ **Uso Responsável**: Este software é fornecido para fins educacionais. O uso em servidores de jogo pode violar os Termos de Serviço. Use por sua conta e risco.

⚠️ **Driver Interception**: Para input em nível kernel, instale o driver Interception separadamente em https://github.com/oblitum/Interception

---

## 📄 Licença

MIT License - Veja LICENSE para detalhes

---

## 👨‍💻 Autor

Desenvolvido como projeto de arquitetura de agentes autônomos com visão computacional e aprendizado por imitação.

---

## 🔮 Futuro (Tibia Global Migration)

A arquitetura modular facilita a migração:
- Trocar apenas o módulo de captura se necessário
- Ajustar thresholds de cores para cliente oficial
- Atualizar templates de itens para nova resolução
- Manter toda lógica de aprendizado e agente
