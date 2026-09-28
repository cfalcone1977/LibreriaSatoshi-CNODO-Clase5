import * as dns from 'dns/promises';
import * as net from 'net';
import * as fs from 'fs';
import * as crypto from 'crypto';

import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

// Registro global de nonces para detectar autoconexiones (self-connections)
const activeNonces = new Set<string>();

// Función pausar y esperar Enter
async function pausar(mensaje = "Presiona Enter para continuar...") {
    const rl = readline.createInterface({ input, output });
    await rl.question(mensaje);
    rl.close();
}

const seeds = [
    "seed.bitcoin.sipa.be",
    "dnsseed.bluematt.be",
    "seed.btc.petertodd.net"
];

interface NodeInfo {
    ip: string;
    seed: string;
    latencyMs: number | null;
    status: 'online' | 'offline';
}

interface NodoConectadoInfo {
    ip: string;
    familiaIP: 'IPv4' | 'IPv6';
    latenciaMs: number;
    protocolVersion: number;
    services: string;
    timestampNodo: string;
    conectadoEn: string;
}

// 1. Función para medir la latencia TCP de un nodo.
function medirLatencia(ip: string, port: number = 8333): Promise<number | null> {
    return new Promise((resolve) => {
        const start = Date.now();
        const socket = new net.Socket();

        socket.setTimeout(3000);

        socket.on('connect', () => {
            const latency = Date.now() - start;
            socket.destroy();
            resolve(latency);
        });

        socket.on('timeout', () => {
            socket.destroy();
            resolve(null);
        });

        socket.on('error', () => {
            socket.destroy();
            resolve(null);
        });

        socket.connect(port, ip);
    });
}

// 2. Descubrir y probar nodos (Genera 'nodos_activos.json')
async function descubrirYProbarNodos() {
    console.log('******************************************************');
    console.log('****** Consultando DNS Seeds y analizando nodos ******');
    console.log('******************************************************');
    await pausar('        ⏸️ Presiona [Enter] para continuar');

    const resultados: NodeInfo[] = [];
    const ipsProcesadas = new Set<string>();

    for (const seed of seeds) {
        console.log(`\nConsultando seed: ${seed}`);
        try {
            const ips = await dns.resolve4(seed);

            for (const ip of ips) {
                if (ipsProcesadas.has(ip)) continue;
                ipsProcesadas.add(ip);

                process.stdout.write(`  Probando ${ip}... `);
                const latency = await medirLatencia(ip);

                if (latency !== null) {
                    console.log(`✅ Online (${latency} ms)`);
                    resultados.push({
                        ip,
                        seed,
                        latencyMs: latency,
                        status: 'online'
                    });
                } else {
                    console.log(`❌ Sin respuesta`);
                }
            }
        } catch (error) {
            console.error(`Error resolviendo ${seed}`);
        }
    }

    resultados.sort((a, b) => (a.latencyMs ?? 9999) - (b.latencyMs ?? 9999));

    const jsonFile = "nodos_activos.json";
    fs.writeFileSync(jsonFile, JSON.stringify(resultados, null, 2));

    console.log('******************************************************');
    console.log(`    Se encontraron ${resultados.length} nodos activos.`);
    console.log(`    Nodos ordenados por latencia en: ${jsonFile}`);
    console.log('******************************************************');
    await pausar('        ⏸️ Presiona [Enter] para continuar');
}

// --- FUNCIONES DE APOYO PARA EL PROTOCOLO BITCOIN ---

function createHeader(command: string, payload: Buffer): Buffer {
    const magic = Buffer.from([0xf9, 0xbe, 0xb4, 0xd9]);

    const commandBuf = Buffer.alloc(12);
    commandBuf.write(command, 'ascii');

    const lengthBuf = Buffer.alloc(4);
    lengthBuf.writeInt32LE(payload.length, 0);

    const hash1 = crypto.createHash('sha256').update(payload as any).digest();
    const hash2 = crypto.createHash('sha256').update(hash1 as any).digest();
    const checksumBuf = hash2.subarray(0, 4);

    return Buffer.concat([magic, commandBuf, lengthBuf, checksumBuf]);
}

function createVersionPayload(): { payload: Buffer; nonceHex: string } {
    const buffer = Buffer.alloc(100);
    let offset = 0;

    buffer.writeInt32LE(70015, offset);
    offset += 4;

    buffer.writeBigInt64LE(0n, offset);
    offset += 8;

    const timestamp = Math.floor(Date.now() / 1000);
    buffer.writeBigInt64LE(BigInt(timestamp), offset);
    offset += 8;

    offset += 26; // Addr Recv
    offset += 26; // Addr From

    const nonce = crypto.randomBytes(8);
    nonce.copy(buffer, offset);
    const nonceHex = nonce.toString('hex');
    offset += 8;

    buffer.writeUInt8(0x00, offset);
    offset += 1;

    buffer.writeInt32LE(0, offset);
    offset += 4;

    buffer.writeInt8(0x01, offset);
    offset += 1;

    return { payload: buffer.subarray(0, offset), nonceHex };
}

// 3. Conexión simultánea a los 8 mejores nodos
async function conectarYMantenerTop8() {
    const jsonPath = 'nodos_activos.json';

    if (!fs.existsSync(jsonPath)) {
        console.log(`\n❌ No se encontró '${jsonPath}'. Ejecuta primero el descubrimiento.`);
        return;
    }

    console.log('******************************************************');
    console.log(`    Leyendo nodos desde ${jsonPath}...`);
    console.log(`    Se utilizaran los 8 nodos con menor Latencia`);
    console.log('******************************************************');
    await pausar('        ⏸️ Presiona [Enter] para continuar');
    const contenido = fs.readFileSync(jsonPath, 'utf-8');
    const nodos: NodeInfo[] = JSON.parse(contenido);

    const top8 = nodos.filter(n => n.status === 'online').slice(0, 8);

    if (top8.length === 0) {
        console.log('⚠️ No hay nodos online disponibles.');
        return;
    }

    console.log(`🚀 Conectando simultáneamente a los ${top8.length} nodos más rápidos...`);
    const resultadosConectados: NodoConectadoInfo[] = [];

    const promesasConexion = top8.map((nodo) => {
        return new Promise<void>((resolve) => {
            const socket = new net.Socket();
            socket.setTimeout(120000);
            let handshakeCompletado = false;
            let bufferRestante = Buffer.alloc(0);

            socket.on('connect', () => {
                console.log(`<-- [${nodo.ip}] Conectado TCP. 1️⃣ ENVIANDO mi 'version'...`);
                const { payload, nonceHex } = createVersionPayload();
                activeNonces.add(nonceHex); // Registramos nuestro nonce
                const header = createHeader('version', payload);
                socket.write(Buffer.concat([header, payload]));
            });

            socket.on('data', (data) => {
                const dataBuffer = data as unknown as Buffer;
                bufferRestante = Buffer.concat([bufferRestante, dataBuffer]);

                while (bufferRestante.length >= 24) {
                    const command = bufferRestante.subarray(4, 16).toString('ascii').replace(/\0/g, '');
                    const length = bufferRestante.readUInt32LE(16);
                    const totalMessageLength = 24 + length;

                    if (bufferRestante.length < totalMessageLength) {
                        break; // Faltan datos por llegar en el stream TCP
                    }

                    const messagePayload = bufferRestante.subarray(24, totalMessageLength);
                    bufferRestante = bufferRestante.subarray(totalMessageLength);

                    let offset = 0;

                    if (command === 'version') {
                        const protocolVersion = messagePayload.readInt32LE(offset);
                        const services = messagePayload.readBigInt64LE(offset + 4);
                        const timestamp = messagePayload.readBigInt64LE(offset + 12);

                        const fechaNode = new Date(Number(timestamp) * 1000).toISOString();
                        const familiaIP = nodo.ip.includes(':') ? 'IPv6' : 'IPv4';

                        console.log(`--> [${nodo.ip}] 2️⃣ RECIBIDO 'version' del nodo (Protocolo: ${protocolVersion}).`);

                        resultadosConectados.push({
                            ip: nodo.ip,
                            familiaIP,
                            latenciaMs: nodo.latencyMs!,
                            protocolVersion,
                            services: services.toString(),
                            timestampNodo: fechaNode,
                            conectadoEn: new Date().toISOString()
                        });

                    } else if (command === 'verack') {
                        console.log(`--> [${nodo.ip}] 3️⃣ RECIBIDO 'verack' del nodo.`);

                        if (!handshakeCompletado) {
                            console.log(`<-- [${nodo.ip}] 4️⃣ ENVIANDO mi 'verack'... Handshake bilateral listo.`);
                            const verackHeader = createHeader('verack', Buffer.alloc(0));
                            socket.write(verackHeader);
                            handshakeCompletado = true;

                            console.log(`<-- [${nodo.ip}] 5️⃣ ENVIANDO 'getaddr' para solicitar nodos...`);
                            const getaddrPayload = Buffer.alloc(0);
                            const getaddrHeader = createHeader('getaddr', getaddrPayload);
                            socket.write(Buffer.concat([getaddrHeader, getaddrPayload]));
                        }

                    } else if (command === 'addr') {
                        console.log(`==> [${nodo.ip}] 📥 ¡RECIBIDO 'addr'! Procesando direcciones...`);
                        let payloadOffset = 0;

                        function readVarInt(buf: Buffer, off: number): { value: number; bytesRead: number } {
                            if (off >= buf.length) return { value: 0, bytesRead: 0 };
                            const first = buf.readUInt8(off);
                            if (first < 0xfd) return { value: first, bytesRead: 1 };
                            if (first === 0xfd) return { value: buf.readUInt16LE(off + 1), bytesRead: 3 };
                            if (first === 0xfe) return { value: buf.readUInt32LE(off + 1), bytesRead: 5 };
                            return { value: Number(buf.readBigUInt64LE(off + 1)), bytesRead: 9 };
                        }

                        const countResult = readVarInt(messagePayload, payloadOffset);
                        payloadOffset += countResult.bytesRead;
                        const totalNodos = countResult.value;

                        const nuevasIpsEncontradas: { ip: string; port: number; descubiertoDe: string; timestamp: string }[] = [];

                        for (let i = 0; i < totalNodos; i++) {
                            if (payloadOffset + 30 > messagePayload.length) break;

                            const nodeTimestamp = messagePayload.readUInt32LE(payloadOffset);
                            payloadOffset += 4 + 8;
                            const ipBytes = messagePayload.subarray(payloadOffset, payloadOffset + 16);
                            payloadOffset += 16;
                            const port = messagePayload.readUInt16BE(payloadOffset);
                            payloadOffset += 2;

                            const isIpv4 = ipBytes.subarray(0, 12).every((b, idx) => {
                                if (idx === 10 || idx === 11) return b === 0xff;
                                return b === 0;
                            });

                            if (isIpv4 || ipBytes.subarray(0, 12).every(b => b === 0)) {
                                const ipStr = `${ipBytes[12]}.${ipBytes[13]}.${ipBytes[14]}.${ipBytes[15]}`;
                                if (ipStr !== '0.0.0.0' && port > 0) {
                                    nuevasIpsEncontradas.push({
                                        ip: ipStr,
                                        port,
                                        descubiertoDe: nodo.ip,
                                        timestamp: new Date(nodeTimestamp * 1000).toISOString()
                                    });
                                }
                            }
                        }

                        const peersFilePath = 'ipsPeers.json';
                        let peersActuales: any[] = [];

                        if (fs.existsSync(peersFilePath)) {
                            try {
                                peersActuales = JSON.parse(fs.readFileSync(peersFilePath, 'utf-8'));
                            } catch (e) {
                                peersActuales = [];
                            }
                        }

                        const ipsExistentes = new Set(peersActuales.map(p => p.ip));
                        let agregadasCount = 0;

                        for (const nuevoPeer of nuevasIpsEncontradas) {
                            if (!ipsExistentes.has(nuevoPeer.ip)) {
                                peersActuales.push(nuevoPeer);
                                ipsExistentes.add(nuevoPeer.ip);
                                agregadasCount++;
                            }
                        }

                        fs.writeFileSync(peersFilePath, JSON.stringify(peersActuales, null, 2));
                        console.log(`💾 Archivo 'ipsPeers.json' actualizado. Se agregaron ${agregadasCount} nuevas IPs (Total: ${peersActuales.length}).`);

                    } else if (command === 'ping') {
                        console.log(`==> [${nodo.ip}] RECIBIDO 'ping'`);
                        const pongHeader = createHeader('pong', messagePayload);
                        socket.write(Buffer.concat([pongHeader, messagePayload]));
                    }
                }
            });

            socket.on('timeout', () => {
                socket.destroy();
                resolve();
            });

            socket.on('error', () => {
                socket.destroy();
                resolve();
            });

            socket.on('close', () => {
                console.log(`🔌 [${nodo.ip}] Conexión cerrada.`);
                resolve();
            });

            socket.connect(8333, nodo.ip);
        });
    });

    await Promise.all(promesasConexion);

    const outputFile = 'nodos_conectados.json';
    fs.writeFileSync(outputFile, JSON.stringify(resultadosConectados, null, 2));
    console.log('*****************************************************************');
    console.log(`                    CONEXIONES TERMINADAS`);
    console.log(` 📁Archivo de metadatos generado en: ${outputFile}📁`);
    console.log('*****************************************************************');
    await pausar('        ⏸️ Presiona [Enter] para continuar');
}

// 4. Servidor Bitcoin para aceptar conexiones entrantes
function iniciarServidorBitcoin() {
    const servidor = net.createServer((socket) => {
        const remoteIp = socket.remoteAddress;
        if (remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1') {
            socket.destroy();
            return;
        }
        console.log(`\n🛜 [SERVIDOR] ¡Nueva conexión entrante desde ${remoteIp}!`);

        let bufferServidorRestante = Buffer.alloc(0);

        socket.on('data', (data) => {
            const dataBuffer = data as unknown as Buffer;
            bufferServidorRestante = Buffer.concat([bufferServidorRestante, dataBuffer]);

            while (bufferServidorRestante.length >= 24) {
                const command = bufferServidorRestante.subarray(4, 16).toString('ascii').replace(/\0/g, '');
                const length = bufferServidorRestante.readUInt32LE(16);
                const totalMessageLength = 24 + length;

                if (bufferServidorRestante.length < totalMessageLength) {
                    break;
                }

                const messagePayload = bufferServidorRestante.subarray(24, totalMessageLength);
                bufferServidorRestante = bufferServidorRestante.subarray(totalMessageLength);

                let offset = 0;

                if (command === 'version') {
                    // Verificar autoconexión mediante el nonce (ubicado en el offset 72 del payload de version)
                    if (messagePayload.length >= 80) {
                        const remoteNonceHex = messagePayload.subarray(72, 80).toString('hex');
                        if (activeNonces.has(remoteNonceHex)) {
                            console.log(`⚠️ [SERVIDOR] ¡Autoconexión detectada! El nonce ${remoteNonceHex} es propio. Cerrando conexión con ${remoteIp}...`);
                            socket.destroy();
                            return;
                        }
                    }

                    const protocolVersion = messagePayload.readInt32LE(offset);
                    console.log(`--> [SERVIDOR] Recibido 'version' de ${remoteIp} (Protocolo: ${protocolVersion})`);

                    console.log(`<-- [SERVIDOR] Respondiendo con mi 'version' y 'verack'...`);
                    const { payload: miPayloadVersion, nonceHex: miNonceHex } = createVersionPayload();
                    activeNonces.add(miNonceHex);
                    const miHeaderVersion = createHeader('version', miPayloadVersion);
                    const miVerackHeader = createHeader('verack', Buffer.alloc(0));

                    socket.write(Buffer.concat([miHeaderVersion, miPayloadVersion, miVerackHeader]));

                } else if (command === 'verack') {
                    console.log(`--> [SERVIDOR] Recibido 'verack' de ${remoteIp}. ¡Handshake completado como servidor!`);

                } else if (command === 'ping') {
                    const pongHeader = createHeader('pong', messagePayload);
                    socket.write(Buffer.concat([pongHeader, messagePayload]));
                }
            }
        });

        socket.on('error', (err) => {
            console.log(`❌ [SERVIDOR] Error en conexión de ${remoteIp}: ${err.message}`);
        });

        socket.on('close', () => {
            console.log(`🔌 [SERVIDOR] Conexión cerrada con ${remoteIp}`);
        });
    });

    servidor.listen(8333, '0.0.0.0', () => {
        console.log("\n");
        console.log("\x1b[32m[SERVIDOR] Escuchando en el puerto 8333 (Listo para recibir peers)...\x1b[0m");
        console.log("\n");
    });
}

// --- FLUJO DE EJECUCIÓN ---
try {
    fs.unlinkSync('nodos_activos.json');
    console.log('Archivos nodos_activos.json eliminado con éxito.\n');
} catch (error) {
    console.log("\n\x1b[33mArchivo nodos_activos.json no existían o no puedo ser eliminado.\x1b[0m\n");
}
try {
    fs.unlinkSync('nodos_conectados.json');
    console.log('Archivo nodos_conectados eliminado con éxito.\n');
} catch (error) {
    console.log("\n\x1b[33mArchivo nodos_conectados no existían o no pudo ser eliminado.\x1b[0m\n");
}
try {
    fs.unlinkSync('ipsPeers.json');
    console.log('Archivo ipsPeers.json eliminado con éxito.\n');
} catch (error) {
    console.log("\n\x1b[33mArchivo ipsPeers.json no existían o no pudo ser eliminado.\x1b[0m\n");
}
async function iniciarCrawler() {
    await descubrirYProbarNodos();
    iniciarServidorBitcoin();
    await conectarYMantenerTop8();
}

iniciarCrawler();