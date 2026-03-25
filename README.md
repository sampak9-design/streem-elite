# Streem Elite 🎥

Live streaming com compartilhamento de tela, chat ao vivo e painel de administração.

## Instalar e rodar

```bash
# 1. Instalar Node.js (se não tiver)
brew install node

# 2. Entrar na pasta e instalar dependências
cd ~/streem-elite
npm install

# 3. Rodar o servidor
npm start
```

Acesse:
- **Host (quem transmite):** http://localhost:3000/host.html
- **Viewer (espectador):** http://localhost:3000/viewer.html

---

## Como usar

### Host (transmissor)
1. Abra `/host.html`
2. Clique **"Compartilhar Tela"** → escolha janela ou tela inteira
3. Dê um título e clique **"Ir ao Vivo"**
4. Um **código de 8 letras** será gerado — compartilhe com os espectadores
5. No painel direito você vê o chat em tempo real
6. Na lista de espectadores pode **remover** alguém
7. Clique em qualquer mensagem para **fixar** no topo do chat

### Viewer (espectador)
1. Abra `/viewer.html` (ou use o link direto que o host gerou)
2. Insira o código da sala + seu apelido
3. A tela do host aparece em tempo real
4. Pode comentar no chat

---

## Funcionalidades

| Recurso | Descrição |
|---|---|
| Compartilhamento de tela | `getDisplayMedia` com áudio opcional |
| Múltiplos viewers | WebRTC mesh — cada viewer tem conexão própria |
| Chat ao vivo | Socket.io, histórico dos últimos 50 msgs |
| Contador de viewers | Tempo real |
| Cronômetro da live | Tempo ao vivo no painel do host |
| Remover espectador | Host pode kickar viewers |
| Fixar mensagem | Host pode fixar msg no topo do chat |
| Código de sala | 8 caracteres, URL compartilhável |

---

## Tecnologias

- **Backend:** Node.js + Express + Socket.io
- **Streaming:** WebRTC (`RTCPeerConnection` + `getDisplayMedia`)
- **Frontend:** HTML/CSS/JS puro (sem framework), dark UI
