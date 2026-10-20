# Глоссарий переводов Cord

Одно понятие — одно слово в каждом языке, во всех каталогах (`locales/*.json`), установщике и боте.
Новый термин — сюда, прежде чем в каталог. Как писать тексты — скилл `.claude/skills/cord-i18n`.

## Тон и форма

| | en | es | fr | it | zh-Hans | de | pt-BR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| обращение | you | tú | vous | tu | 你 | du | você |
| кнопки | глагол: Join, Save | инфинитив: Unirse, Guardar | инфинитив: Rejoindre, Enregistrer | повелительное: Partecipa, Salva | 动词：加入、保存 | инфинитив: Beitreten, Speichern | инфинитив: Entrar, Salvar |
| регистр | Sentence case везде | как в предложении | как в предложении | как в предложении | — | существительные с заглавной, остальное как в предложении | как в предложении |
| кавычки | “…” | «…» | « … » (неразрывные пробелы) | «…» | “…” | „…“ | “…” |
| многоточие | … | … | … | … | … (全角 «……» не нужен) | … | … |

Коротко, как в премиальном приложении (Discord, FACEIT): глагол без лишних слов, без «пожалуйста», без
восклицаний. Технических слов не больше, чем в русском. Числа и единицы — как в языке (`Intl` в коде), «мс»
→ `ms`, «с» → `s` (zh — `秒`), «fps» — как есть.

## Не переводится

- **Cord** — имя продукта, во всех языках латиницей, без склонения.
- Имена площадок и сервисов — их официальные имена на языке: YouTube, SoundCloud, Telegram, VK, VK Видео →
  **VK Video**, RUTUBE, Кинопоиск → **Kinopoisk**, Иви → **ivi**, Okko, Яндекс Музыка → **Yandex Music**
  (у сервиса так называется международная версия; на всех языках кроме ru).
- Имена игр: **Durak** (по-русски «Дурак»; во всех языках — Durak), **Gartic**, Poker / Chess — переводятся
  (см. ниже), `RNNoise`, `PING`, `TCP`, `UDP`, `fps`, `720p`.

## Термины

| ru | en | es | fr | it | zh-Hans | de | pt-BR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| встреча | meeting | reunión | réunion | riunione | 会议 | Meeting | reunião |
| комната (постоянная, в избранном) | room | sala | salle | stanza | 房间 | Raum | sala |
| ведущий | host | anfitrión | hôte | host | 主持人 | Host | anfitrião |
| участник | participant | participante | participant | partecipante | 参与者 | Teilnehmer | participante |
| гость | guest | invitado | invité | ospite | 访客 | Gast | convidado |
| войти во встречу | join | unirse | rejoindre | partecipare | 加入 | beitreten | entrar |
| выйти | leave | salir | quitter | uscire | 离开 | verlassen | sair |
| завершить встречу | end the meeting | finalizar la reunión | mettre fin à la réunion | terminare la riunione | 结束会议 | Meeting beenden | encerrar a reunião |
| просится войти | asks to join | pide unirse | demande à rejoindre | chiede di entrare | 请求加入 | möchte beitreten | pede para entrar |
| зал ожидания | waiting room | sala de espera | salle d'attente | sala d'attesa | 等候室 | Warteraum | sala de espera |
| код встречи | meeting code | código de la reunión | code de la réunion | codice riunione | 会议代码 | Meeting-Code | código da reunião |
| ссылка-приглашение | invite link | enlace de invitación | lien d'invitation | link di invito | 邀请链接 | Einladungslink | link de convite |
| сцена | stage | escenario | scène | palco | 舞台 | Bühne | palco |
| демонстрация (показ) экрана | screen share | compartir pantalla | partage d'écran | condivisione schermo | 屏幕共享 | Bildschirmfreigabe | compartilhamento de tela |
| показать экран | share screen | compartir pantalla | partager l'écran | condividi schermo | 共享屏幕 | Bildschirm teilen | compartilhar tela |
| микрофон | microphone, mic | micrófono | micro | microfono | 麦克风 | Mikrofon | microfone |
| камера | camera | cámara | caméra | videocamera | 摄像头 | Kamera | câmera |
| динамики | speakers | altavoces | haut-parleurs | altoparlanti | 扬声器 | Lautsprecher | alto-falantes |
| шумоподавление | noise suppression | supresión de ruido | suppression du bruit | soppressione del rumore | 降噪 | Rauschunterdrückung | supressão de ruído |
| чат | chat | chat | chat | chat | 聊天 | Chat | chat |
| реакция | reaction | reacción | réaction | reazione | 表情回应 | Reaktion | reação |
| интеграция | integration | integración | intégration | integrazione | 集成 | Integration | integração |
| кинозал | Cinema | Cine | Cinéma | Cinema | 影院 | Kino | Cinema |
| музыка | Music | Música | Musique | Musica | 音乐 | Musik | Música |
| игры | Games | Juegos | Jeux | Giochi | 游戏 | Spiele | Jogos |
| площадка (YouTube, VK…) | platform | plataforma | plateforme | piattaforma | 平台 | Plattform | plataforma |
| плеер | player | reproductor | lecteur | player | 播放器 | Player | player |
| субтитры | subtitles | subtítulos | sous-titres | sottotitoli | 字幕 | Untertitel | legendas |
| очередь (музыки) | queue | cola | file d'attente | coda | 播放队列 | Warteschlange | fila |
| трек | track | canción | titre | brano | 曲目 | Titel | faixa |
| избранное | Favorites | Favoritos | Favoris | Preferiti | 收藏 | Favoriten | Favoritos |
| главная | Home | Inicio | Accueil | Home | 首页 | Start | Início |
| настройки | Settings | Ajustes | Paramètres | Impostazioni | 设置 | Einstellungen | Configurações |
| оформление | Appearance | Apariencia | Apparence | Aspetto | 外观 | Darstellung | Aparência |
| горячие клавиши | Keyboard shortcuts | Atajos de teclado | Raccourcis clavier | Scorciatoie da tastiera | 快捷键 | Tastenkürzel | Atalhos de teclado |
| сочетание (клавиш) | shortcut | atajo | raccourci | scorciatoia | 快捷键 | Tastenkürzel | atalho |
| голос и видео | Voice and video | Voz y vídeo | Voix et vidéo | Voce e video | 语音和视频 | Sprache und Video | Voz e vídeo |
| аккаунты (подключённые сервисы) | Accounts | Cuentas | Comptes | Account | 账号 | Konten | Contas |
| сервер | server | servidor | serveur | server | 服务器 | Server | servidor |
| о программе | About | Acerca de | À propos | Informazioni | 关于 | Über Cord | Sobre |
| обновление | update | actualización | mise à jour | aggiornamento | 更新 | Update | atualização |
| выпуск (версия) | version | versión | version | versione | 版本 | Version | versão |
| приложение для Windows | Windows app | app para Windows | application Windows | app per Windows | Windows 应用 | Windows-App | app para Windows |
| веб-клиент | web app | versión web | version web | versione web | 网页版 | Web-App | versão web |
| вложение, файл | file | archivo | fichier | file | 文件 | Datei | arquivo |
| стол (игровой) | table | mesa | table | tavolo | 牌桌 | Tisch | mesa |
| ход | turn (чей ход), move (шахматы) | turno, jugada | tour, coup | turno, mossa | 回合，走棋 | Zug | vez, jogada |
| раунд | round | ronda | manche | round | 回合 | Runde | rodada |
| фишки | chips | fichas | jetons | fiches | 筹码 | Chips | fichas |
| ставка | bet | apuesta | mise | puntata | 下注 | Einsatz | aposta |

### Покер (как в клиентах PokerStars на языке)

| ru | en | es | fr | it | zh-Hans | de | pt-BR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| пас | Fold | Retirarse | Se coucher | Passa | 弃牌 | Fold | Desistir |
| чек | Check | Pasar | Parole | Check | 过牌 | Check | Passar |
| колл | Call | Igualar | Suivre | Chiama | 跟注 | Call | Pagar |
| ставка | Bet | Apostar | Miser | Punta | 下注 | Bet | Apostar |
| рейз | Raise | Subir | Relancer | Rilancia | 加注 | Raise | Aumentar |
| ва-банк | All-in | All-in | Tapis | All-in | 全下 | All-in | All-in |
| блайнды | blinds (small / big blind) | ciegas (ciega pequeña / grande) | blindes (petite / grosse blinde) | bui (piccolo / grande buio) | 盲注（小盲 / 大盲） | Blinds (Small / Big Blind) | blinds (small / big blind) |
| ребай | rebuy | recompra | recave | rebuy | 重购 | Rebuy | rebuy |
| банк | pot | bote | pot | piatto | 底池 | Pot | pote |
| раздача | hand | mano | main | mano | 牌局 | Hand | mão |
| вскрытие | showdown | showdown | abattage | showdown | 摊牌 | Showdown | showdown |

### Дурак

| ru | en | es | fr | it | zh-Hans | de | pt-BR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| козырь | trump | triunfo | atout | briscola | 王牌 | Trumpf | trunfo |
| колода | deck | mazo | pioche | mazzo | 牌堆 | Stapel | baralho |
| отбиться | beat | defenderse | défendre | difendersi | 防守 | abwehren | defender |
| подкинуть | add | añadir | ajouter | aggiungere | 追加 | nachlegen | adicionar |
| перевести | pass on | pasar | renvoyer | passare | 转移 | weitergeben | passar |
| взять | take | recoger | ramasser | prendere | 收牌 | aufnehmen | pegar |
| бито | done | listo | défaussé | fatto | 弃牌堆 | erledigt | descartado |
| дурак (проигравший) | durak (the fool) | el tonto | le dupe | lo sciocco | 输家（傻瓜） | der Durak | o bobo |

### Шахматы

| ru | en | es | fr | it | zh-Hans | de | pt-BR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| шахматы | Chess | Ajedrez | Échecs | Scacchi | 国际象棋 | Schach | Xadrez |
| белые / чёрные | White / Black | blancas / negras | Blancs / Noirs | Bianco / Nero | 白方 / 黑方 | Weiß / Schwarz | brancas / pretas |
| шах / мат | check / checkmate | jaque / jaque mate | échec / échec et mat | scacco / scacco matto | 将军 / 将死 | Schach / Schachmatt | xeque / xeque-mate |
| пат | stalemate | ahogado | pat | stallo | 逼和 | Patt | afogamento |
| ничья | draw | tablas | nulle | patta | 和棋 | Remis | empate |
| сдаться | resign | rendirse | abandonner | abbandonare | 认输 | aufgeben | desistir |
| контроль времени | time control | control de tiempo | cadence | cadenza | 用时 | Bedenkzeit | ritmo |

### Gartic (рисуем и угадываем)

| ru | en | es | fr | it | zh-Hans | de | pt-BR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| рисунок | drawing | dibujo | dessin | disegno | 画作 | Zeichnung | desenho |
| альбом | album | álbum | album | album | 画册 | Album | álbum |
| подсказка, фраза | prompt | frase | phrase | frase | 题目 | Satz | frase |
| угадать | guess | adivinar | deviner | indovinare | 猜 | erraten | adivinhar |
