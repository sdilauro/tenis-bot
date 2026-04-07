# Deploy - Tenis Bot en Oracle Cloud Free Tier

## 1. Crear cuenta en Oracle Cloud

1. Ir a **cloud.oracle.com** y registrarse
2. Pide tarjeta de crédito pero **no cobra** (solo verificación)
3. Elegir región **São Paulo** (`sa-saopaulo-1`) — la más cercana a Argentina

## 2. Crear la VM (Always Free)

1. **Compute → Instances → Create Instance**
2. Image: **Ubuntu 22.04**
3. Shape: **VM.Standard.A1.Flex** (ARM) — 1 OCPU, 2GB RAM
4. Descargar la **clave privada SSH** (.key) y guardarla en un lugar seguro
5. En networking dejar que cree una VCN nueva con subnet pública

## 3. Abrir el puerto 3000

### En Oracle Cloud (Security List)

1. **Networking → Virtual Cloud Networks → tu VCN → Security Lists → Default**
2. Agregar **Ingress Rule**:
   - Source: `0.0.0.0/0`
   - Protocol: TCP
   - Destination Port: `3000`

### En la VM (firewall del OS)

```bash
sudo iptables -I INPUT -p tcp --dport 3000 -j ACCEPT
sudo netfilter-persistent save
```

## 4. Conectarse a la VM

```bash
ssh -i tu_clave.key ubuntu@<IP_PUBLICA>
```

> En Windows podés usar PowerShell, Git Bash, o el cliente SSH integrado.

## 5. Instalar dependencias en la VM

```bash
# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git

# PM2 (process manager, mantiene el bot corriendo 24/7)
sudo npm i -g pm2
```

## 6. Clonar y configurar el bot

```bash
git clone https://github.com/TU_USER/tenis-bot.git
cd tenis-bot
npm ci --omit=dev
```

Crear el archivo `.env`:

```bash
nano .env
```

Contenido:

```
CAEP_EMAIL=tu_email
CAEP_PASSWORD=tu_password
```

## 7. Iniciar con PM2

```bash
# Iniciar el bot
pm2 start server.js --name tenis-bot

# Guardar la lista de procesos
pm2 save

# Configurar inicio automático al reiniciar la VM
pm2 startup
# (seguir las instrucciones que muestra en pantalla)
```

## 8. Verificar

```bash
# Ver logs
pm2 logs tenis-bot

# Ver estado
pm2 status

# Acceder desde el navegador
# http://<IP_PUBLICA>:3000
```

## Comandos útiles de PM2

```bash
pm2 restart tenis-bot   # reiniciar
pm2 stop tenis-bot      # detener
pm2 logs tenis-bot      # ver logs en tiempo real
pm2 monit               # monitor interactivo
```

## Actualizar el bot

```bash
cd ~/tenis-bot
git pull
npm ci --omit=dev
pm2 restart tenis-bot
```
