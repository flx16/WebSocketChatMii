# Procédure de démarage

Installer ce projet dans wsl

## Démarrer le serveur

```bash 
  docker compose up
```

## Construire l'image docker

```bash
    docker build -t websocket-chatmii:latest.
```

## Mettre la nouvelle version l'image docker dans l'API

- Delete les containers, volumes et images (sauf celle du websocket)
- Restart l'api (voir la procédure dans le README de l'API)