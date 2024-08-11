require('dotenv').config();
const { Client, GatewayIntentBits, TextChannel } = require('discord.js');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();

const token = process.env.DISCORD_TOKEN;
const apiFootballKey = process.env.API_FOOTBALL_KEY;
const channelId = process.env.DISCORD_CHANNEL_ID;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// Conectar ao banco de dados SQLite
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) {
        console.error('Erro ao conectar ao banco de dados:', err.message);
    } else {
        console.log('Conexão bem-sucedida ao banco de dados');
        createTables();
    }
});

// Função para criar tabelas se elas ainda não existirem
function createTables() {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS match_stats (
            id INTEGER PRIMARY KEY,
            league_name TEXT,
            first_half INTEGER,
            second_half INTEGER,
            no_goals INTEGER DEFAULT 0
        )`, (err) => {
            if (err) {
                console.error('Erro ao criar tabela:', err.message);
            } else {
                console.log('Tabela criada com sucesso: match_stats');
            }
        });

        // Adicionar a coluna no_goals se não existir
        db.run(`ALTER TABLE match_stats ADD COLUMN no_goals INTEGER DEFAULT 0`, (err) => {
            if (err && !err.message.includes("duplicate column name")) {
                console.error('Erro ao adicionar coluna no_goals:', err.message);
            }
        });
    });
}

// Função para atualizar estatísticas da liga
function updateLeagueStats(leagueName, firstHalf, secondHalf, noGoals) {
    const sql = `INSERT INTO match_stats (league_name, first_half, second_half, no_goals) VALUES (?, ?, ?, ?)
                 ON CONFLICT(league_name) DO UPDATE SET first_half = ?, second_half = ?, no_goals = ?`;
    db.run(sql, [leagueName, firstHalf, secondHalf, noGoals, firstHalf, secondHalf, noGoals], (err) => {
        if (err) {
            console.error('Erro ao atualizar estatísticas da liga:', err.message);
        } else {
            console.log('Estatísticas da liga atualizadas com sucesso');
        }
    });
}

// Função para recuperar estatísticas da liga por nome da liga
function getLeagueStats(leagueName, callback) {
    const sql = `SELECT * FROM match_stats WHERE league_name = ?`;
    db.get(sql, [leagueName], (err, row) => {
        if (err) {
            console.error('Erro ao recuperar estatísticas da liga:', err.message);
            callback(null);
        } else {
            callback(row);
        }
    });
}

// Armazenar os IDs dos eventos de gol e os últimos corners enviados
const sentGoalEvents = new Set();
const sentTipMessages = new Map(); // Mapa para armazenar mensagens de possível entrada já enviadas e o placar no momento
const matchStatus = new Map(); // Mapa para armazenar o estado dos jogos (se houve gol após possível entrada)
const halfTimeReported = new Set(); // Mapa para armazenar jogos com mensagem de half time enviada

let greenCountFirstHalf = 0; // Contador de greens no 1st half
let greenCountSecondHalf = 0; // Contador de greens no 2nd half
let redCount = 0; // Contador de reds

// Mapa para armazenar estatísticas por liga
const leagueStats = new Map();

function connectWebSocket() {
    const socket = new WebSocket('wss://wss.allsportsapi.com/live_events?widgetKey=' + apiFootballKey + '&timezone=+03:00');

    socket.onopen = () => {
        console.log('Conectado ao WebSocket');
    };

    socket.onmessage = function (e) {
        if (e.data) {
            try {
                const matchesData = JSON.parse(e.data);
                handleEvent(matchesData);
            } catch (error) {
                console.error('Erro ao analisar os dados da mensagem:', error);
            }
        }
    };

    socket.onclose = () => {
        console.log('WebSocket desconectado, tentando reconectar...');
        setTimeout(connectWebSocket, 5000);
    };

    socket.onerror = (error) => {
        console.error('Erro no WebSocket:', error);
        socket.close();
    };
}

async function handleEvent(eventData) {
    if (!Array.isArray(eventData) || eventData.length === 0) {
        console.error('Dados do evento inválidos.');
        return;
    }

    eventData.forEach(event => {
        const homeTeam = event.event_home_team;
        const awayTeam = event.event_away_team;
        const matchKey = `${homeTeam} vs ${awayTeam}`;
        const infoTime = event.info_time || 'Unknown'; // Verifica o tempo do evento (1st Half ou 2nd Half)
        const leagueName = event.league_name || 'Unknown';

        // Verifica se houve mudança para Half Time em um jogo marcado como TIP_SENT
        if (event.event_status === 'Half Time' && matchStatus.get(matchKey) === 'TIP_SENT' && !halfTimeReported.has(matchKey)) {
            const pendingMessage = `-----------------------------------------------------------------------\n⚠️ **ENTRADA DE GOL - 2nd HALF** ⚠️\n${matchKey}\n-----------------------------------------------------------------------`;
            sendToDiscord(pendingMessage);
            halfTimeReported.add(matchKey);
        }

        // Verifica se houve gol
        if (event.event_key && !sentGoalEvents.has(event.event_key) &&
            event.event_home_team && event.event_away_team &&
            event.event_final_result && event.goalscorers && event.goalscorers.length > 0) {

            const score = event.event_final_result;
            const goalScorer = event.goalscorers[0].home_scorer || event.goalscorers[0].away_scorer;
            const goalTime = event.goalscorers[0].time;
            let infoTime = event.goalscorers[0].info_time || 'Unknown';

            if (goalScorer) {
                if (matchStatus.get(matchKey) === 'TIP_SENT') {
                    const goalMessage = `-----------------------------------------------------------------------\n*GOOOOOOOOOOOOOOOOOOOOOOOOL!*  ⚽ \n\n**${goalScorer}** marcou para o **${homeTeam}** contra o **${awayTeam}** aos **${goalTime}** minutos. \n\n**Placar:** ${score}\n-----------------------------------------------------------------------`;
                    sendToDiscord(goalMessage);
                    sentGoalEvents.add(event.event_key);
                    matchStatus.set(matchKey, 'GREEN');

                    if (infoTime === '1st Half') {
                        greenCountFirstHalf++;
                    } else if (infoTime === '2nd Half') {
                        greenCountSecondHalf++;
                    }

                    updateLeagueStatsInMemory(leagueName, infoTime);

                    const greenMessage = `-----------------------------------------------------------------------\n🟢 **GREEN!** 🟢 \n\nO jogo entre **${homeTeam}** e **${awayTeam}** teve um gol após a entrada. ✅\n-----------------------------------------------------------------------`;
                    sendToDiscord(greenMessage);
                }
            } else {
                console.error('Nome do marcador de gol não encontrado:', event);
            }
        }

        // Verifica as estatísticas para corners, chutes e chutes ao gol
        if (event.statistics && event.statistics.length > 0) {
            const shotsOnTarget = event.statistics.find(stat => stat.type === 'On Target');
            const shotsOffTarget = event.statistics.find(stat => stat.type === 'Off Target');
            const dangerousAttacks = event.statistics.find(stat => stat.type === 'Dangerous Attacks');
            
            if (dangerousAttacks && event.event_status && !sentTipMessages.has(matchKey)) {
                const score = event.event_final_result;
                const eventStatus = parseInt(event.event_status, 10);
                const homeDangerousAttacks = parseInt(dangerousAttacks.home, 10);
                const awayDangerousAttacks = parseInt(dangerousAttacks.away, 10);

                if (homeDangerousAttacks >= eventStatus || awayDangerousAttacks >= eventStatus) {
                    let tipMessage = `-----------------------------------------------------------------------\n🟢 **POSSÍVEL ENTRADA DE GOL!** 🟢 \n\n**Liga:** ${leagueName}\n\n**Ataques perigosos:** ${homeTeam} **(${homeDangerousAttacks})** x **(${awayDangerousAttacks})** ${awayTeam}.\n`;

                    tipMessage += `\n**Placar atual:** ${homeTeam} **${score}** ${awayTeam} aos **${eventStatus}** minutos.\n`;

                    const leagueStatsMessage = `📊 **Estatísticas da ${leagueName}** 📊 \n\n**🟢 1st Half:** ${leagueStats.get(leagueName)?.firstHalf || 0}\n**🟢 2nd Half:** ${leagueStats.get(leagueName)?.secondHalf || 0}\n**🔴 No Goals:** ${leagueStats.get(leagueName)?.noGoals || 0}\n-----------------------------------------------------------------------`;
                    tipMessage += `\n${leagueStatsMessage}`;

                    sendToDiscord(tipMessage);

                    const currentScore = event.event_final_result;
                    sentTipMessages.set(matchKey, currentScore);
                    matchStatus.set(matchKey, 'TIP_SENT');
                }
            }
        } else {
            console.error('Estatísticas não encontradas ou estão vazias:', event.statistics);
        }

        // Verifica o estado final do jogo para enviar "Green" ou "Red"
        if (event.event_status === 'Finished') {
            if (matchStatus.get(matchKey) === 'TIP_SENT') {
                const initialScore = sentTipMessages.get(matchKey);

                if (initialScore !== event.event_final_result) {
                    matchStatus.set(matchKey, 'GREEN');
                    const greenMessage = `-----------------------------------------------------------------------\n🟢 **GREEN!** 🟢 \n\nO jogo entre **${homeTeam}** e **${awayTeam}** teve um gol após a entrada. ✅\n-----------------------------------------------------------------------`;
                    sendToDiscord(greenMessage);

                    if (infoTime === '1st Half') {
                        greenCountFirstHalf++;
                    } else if (infoTime === '2nd Half') {
                        greenCountSecondHalf++;
                    }
                } else {
                    matchStatus.set(matchKey, 'RED');
                    redCount++;
                    updateLeagueStats(leagueName, leagueStats.get(leagueName)?.firstHalf || 0, leagueStats.get(leagueName)?.secondHalf || 0, redCount);

                    const redMessage = `-----------------------------------------------------------------------\n🔴 **FAZ O L!** 🔴 \n\nO jogo entre **${homeTeam}** e **${awayTeam}** terminou e não houve gol após a entrada.\n-----------------------------------------------------------------------`;
                    sendToDiscord(redMessage);
                }

                matchStatus.set(matchKey, 'FINISHED');
            }
        }
    });

    function printTipSentGames() {
        const tipSentGames = [];
        matchStatus.forEach((value, key) => {
            if (value === 'TIP_SENT') {
                tipSentGames.push(key);
            }
        });

        if (tipSentGames.length > 0) {
            console.log("Jogos marcados como 'TIP_SENT':");
            tipSentGames.forEach(game => {
                console.log(game);
            });
        }
    }

    setInterval(printTipSentGames, 600000); // Ajuste o intervalo conforme necessário (10 minutos = 600000 ms)
}

function updateLeagueStatsInMemory(leagueName, infoTime) {
    if (!leagueStats.has(leagueName)) {
        leagueStats.set(leagueName, { firstHalf: 0, secondHalf: 0, noGoals: 0 });
    }

    const stats = leagueStats.get(leagueName);

    if (infoTime === '1st Half') {
        stats.firstHalf++;
    } else if (infoTime === '2nd Half') {
        stats.secondHalf++;
    }

    leagueStats.set(leagueName, stats);

    // Atualizar no banco de dados
    updateLeagueStats(leagueName, stats.firstHalf, stats.secondHalf, stats.noGoals);
}

function sendToDiscord(message) {
    const channel = client.channels.cache.get(channelId);
    if (channel instanceof TextChannel) {
        channel.send(message).catch(error => {
            console.error('Erro ao enviar mensagem para o Discord:', error);
        });
    } else {
        console.log(`Canal não encontrado ou não é um canal de texto válido.`);
    }
}

client.once('ready', () => {
    console.log(`Bot conectado como ${client.user.tag}`);
    connectWebSocket();
});

// Evento beforeExit para fechar o banco de dados SQLite corretamente antes de encerrar o servidor
process.on('beforeExit', () => {
    console.log('Fechando conexão com o banco de dados...');
    db.close((err) => {
        if (err) {
            return console.error('Erro ao fechar conexão com o banco de dados:', err.message);
        }
        console.log('Conexão com o banco de dados fechada com sucesso');
    });
});

client.login(token);
