/* Motor do jogo: cartas, mapa e todas as regras. Roda no celular do anfitrião (o "juiz").
   Não conhece internet nem tela. Funciona no navegador (global Motor) e no Node (require). */
(function (raiz, fabrica) {
  if (typeof module === "object" && module.exports) module.exports = fabrica();
  else raiz.Motor = fabrica();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MIN_JOGADORES = 2, MAX_JOGADORES = 8, TAM = 15, BLOCO = 3, PASSO_BLOCO = 6;

  class ErroJogo extends Error {}

  /* ------------------------------------------------------------- sorteio */
  function rngSeguro() {
    const c = (typeof crypto !== "undefined" && crypto.getRandomValues) ? crypto : require("crypto").webcrypto;
    const sorteio = n => {                       // inteiro uniforme em [0, n)
      const lim = Math.floor(0x100000000 / n) * n;
      const b = new Uint32Array(1);
      do { c.getRandomValues(b); } while (b[0] >= lim);
      return b[0] % n;
    };
    return {
      int: (a, b) => a + sorteio(b - a + 1),
      choice: arr => arr[sorteio(arr.length)],
      shuffle: arr => { for (let i = arr.length - 1; i > 0; i--) { const j = sorteio(i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; } },
    };
  }
  /* Sorteio com semente, só para testes */
  function rngComSemente(semente) {
    let s = semente >>> 0;
    const prox = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    return {
      int: (a, b) => a + Math.floor(prox() * (b - a + 1)),
      choice: arr => arr[Math.floor(prox() * arr.length)],
      shuffle: arr => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(prox() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } },
    };
  }

  /* -------------------------------------------------------------- cenário */
  const BOA_ESPERANCA = Object.freeze({
    id: "boa_esperanca",
    nome: "Mistério em Boa Esperança",
    vitima: "Seu Abelardo Ferraz",
    suspeitos: ["Dona Cida", "Seu Tonico", "Padre Lúcio", "Dra. Helena", "Zeca", "Marlene", "Nilton", "Rosa"],
    locais: ["Praça da Matriz", "Igreja", "Padaria", "Posto de gasolina", "Fazenda", "Rodoviária", "Cartório", "Farmácia", "Armazém"],
    armas: ["Enxada", "Corda", "Veneno de rato", "Chave inglesa", "Candelabro", "Foice"],
    grade: [["Igreja", "Praça da Matriz", "Cartório"], ["Padaria", "Armazém", "Farmácia"], ["Fazenda", "Rodoviária", "Posto de gasolina"]],
    atalhos: [["Igreja", "Posto de gasolina"], ["Cartório", "Fazenda"]],
    localInicial: "Praça da Matriz",
    emojiSuspeitos: ["👵", "👨‍🌾", "🧔", "👩‍⚕️", "👦", "💃", "👷", "👩‍🍳"],
    emojiLocais: { "Praça da Matriz": "⛲", "Igreja": "⛪", "Padaria": "🥖", "Posto de gasolina": "⛽", "Fazenda": "🐄", "Rodoviária": "🚌", "Cartório": "📜", "Farmácia": "💊", "Armazém": "📦" },
    tema: { padrao: "pedra", rua: "#2a2219", linha: "#3a3023", sala: "#1a140e", borda: "#b08a4a" },
  });
  const COLEGIO = Object.freeze({
    id: "colegio",
    nome: "Mistério no Colégio Santa Aurora",
    vitima: "Professor Edgar Monteiro",
    suspeitos: ["Diretora Neuza", "Prof. Cláudio", "Tia Marta", "Seu Osvaldo", "Lúcia da Biblioteca", "Coordenador Renan", "Profa. Sônia", "Beto do 3º ano"],
    locais: ["Diretoria", "Biblioteca", "Secretaria", "Laboratório", "Pátio", "Auditório", "Quadra", "Cantina", "Sala dos Professores"],
    armas: ["Régua de ferro", "Giz envenenado", "Extintor", "Apito", "Cabo de vassoura", "Compasso"],
    grade: [["Biblioteca", "Diretoria", "Secretaria"], ["Laboratório", "Pátio", "Auditório"], ["Quadra", "Cantina", "Sala dos Professores"]],
    atalhos: [["Biblioteca", "Sala dos Professores"], ["Secretaria", "Quadra"]],
    localInicial: "Pátio",
    emojiSuspeitos: ["👩‍💼", "👨‍🏫", "👩‍🍳", "👨‍🔧", "👩‍🦰", "🧑‍💼", "👩‍🏫", "🧒"],
    emojiLocais: { "Diretoria": "💼", "Biblioteca": "📚", "Secretaria": "🗂️", "Laboratório": "🔬", "Pátio": "🌳", "Auditório": "🎭", "Quadra": "🏀", "Cantina": "🍽️", "Sala dos Professores": "☕" },
    tema: { padrao: "ladrilho", rua: "#1d2530", linha: "#2b3745", sala: "#141a22", borda: "#6f9bd1" },
  });
  const HOTEL = Object.freeze({
    id: "hotel",
    nome: "Mistério no Grande Hotel Imperial",
    vitima: "Sr. Valmont, hóspede da suíte 12",
    suspeitos: ["Dolores, a camareira", "Sr. Augusto, o gerente", "Madame Vivianne", "Coronel Tavares", "Chef Pierre", "Bento, o porteiro", "Dr. Lacerda", "Srta. Ísis, a cantora"],
    locais: ["Saguão", "Restaurante", "Cozinha", "Piscina", "Bar", "Suíte Presidencial", "Jardim de Inverno", "Adega", "Cobertura"],
    armas: ["Castiçal de bronze", "Faca de cozinha", "Cordão da cortina", "Chá envenenado", "Taco de sinuca", "Garrafa de vinho"],
    grade: [["Adega", "Cozinha", "Cobertura"], ["Restaurante", "Saguão", "Bar"], ["Jardim de Inverno", "Piscina", "Suíte Presidencial"]],
    atalhos: [["Adega", "Suíte Presidencial"], ["Cobertura", "Jardim de Inverno"]],
    localInicial: "Saguão",
    emojiSuspeitos: ["👩‍🦱", "🤵", "👸", "👨‍✈️", "👨‍🍳", "💂", "👨‍⚕️", "👩‍🎤"],
    emojiLocais: { "Saguão": "🛎️", "Restaurante": "🍷", "Cozinha": "🍳", "Piscina": "🏊", "Bar": "🍸", "Suíte Presidencial": "👑", "Jardim de Inverno": "🌿", "Adega": "🍾", "Cobertura": "🌆" },
    tema: { padrao: "tapete", rua: "#2a1418", linha: "#4a2530", sala: "#1c0e11", borda: "#c9a93b" },
  });
  const PACOTES = { [BOA_ESPERANCA.id]: BOA_ESPERANCA, [COLEGIO.id]: COLEGIO, [HOTEL.id]: HOTEL };
  const todasAsCartas = p => [...p.suspeitos, ...p.locais, ...p.armas];

  /* ----------------------------------------------------------------- mapa */
  /* Tabuleiro de 15x15 casas. Os 9 locais ocupam blocos de 3x3 casas; entre eles ficam ruas de 3 casas de largura.
     Cada local tem uma casa de ENTRADA (só entra por ela) e uma casa de SAÍDA (só sai por ela).
     Casa de rua = "rua:x:y". Entrar em um local encerra o movimento. */
  const idRua = (x, y) => `rua:${x}:${y}`;
  class Mapa {
    constructor(pacote) {
      this.tam = TAM; this.locais = new Set(pacote.locais);
      this.atalhos = new Map();
      for (const [a, b] of pacote.atalhos) { this.atalhos.set(a, b); this.atalhos.set(b, a); }
      this.salas = []; this.sala = new Map(); this.entradaDe = new Map(); this.saidaDe = new Map(); this._dentro = new Set();
      const g = pacote.grade, ultima = g.length - 1;
      g.forEach((linha, r) => linha.forEach((nome, c) => {
        const x0 = c * PASSO_BLOCO, y0 = r * PASSO_BLOCO;
        for (let dx = 0; dx < BLOCO; dx++) for (let dy = 0; dy < BLOCO; dy++) this._dentro.add(`${x0 + dx},${y0 + dy}`);
        const entrada = c > 0 ? { x: x0 - 1, y: y0 + 1, seta: "dir" } : { x: x0 + BLOCO, y: y0 + 1, seta: "esq" };
        const saida = r < ultima ? { x: x0 + 1, y: y0 + BLOCO, seta: "baixo" } : { x: x0 + 1, y: y0 - 1, seta: "cima" };
        const sala = { nome, x0, y0, larg: BLOCO, alt: BLOCO, entrada, saida };
        this.salas.push(sala); this.sala.set(nome, sala);
        this.entradaDe.set(idRua(entrada.x, entrada.y), nome); this.saidaDe.set(nome, idRua(saida.x, saida.y));
      }));
    }
    ehLocal(no) { return this.locais.has(no); }
    ehRua(x, y) { return x >= 0 && y >= 0 && x < this.tam && y < this.tam && !this._dentro.has(`${x},${y}`); }
    valido(no) {
      if (this.locais.has(no)) return true;
      const m = /^rua:(\d+):(\d+)$/.exec(String(no));
      return !!m && this.ehRua(+m[1], +m[2]);
    }
    vizinhos(no) {
      if (this.locais.has(no)) return [this.saidaDe.get(no)];
      const m = /^rua:(\d+):(\d+)$/.exec(no), x = +m[1], y = +m[2], out = [];
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) if (this.ehRua(x + dx, y + dy)) out.push(idRua(x + dx, y + dy));
      const sala = this.entradaDe.get(no); if (sala) out.push(sala);
      return out;
    }
    /* Casas que dá para alcançar em até `passos` passos. Mapa casa -> passos. Casas ocupadas por outros bloqueiam. */
    alcancaveis(origem, passos, ocupadas) {
      const dist = new Map([[origem, 0]]); let fila = [origem];
      while (fila.length) {
        const prox = [];
        for (const n of fila) {
          const d = dist.get(n); if (d >= passos) continue;
          for (const v of this.vizinhos(n)) {
            if (dist.has(v)) continue;
            if (!this.locais.has(v) && ocupadas.has(v)) continue;
            dist.set(v, d + 1);
            if (!this.locais.has(v)) prox.push(v);      // entrar em local encerra o movimento
          }
        }
        fila = prox;
      }
      return dist;
    }
    /* Distância em passos ignorando quem está no caminho (usado pelos bots). */
    distancia(a, b) { const d = this.alcancaveis(a, 999, new Set()); return d.has(b) ? d.get(b) : Infinity; }
    /* Descrição do tabuleiro para a tela desenhar. */
    layout() {
      return { tam: this.tam, salas: this.salas.map(s => ({ nome: s.nome, x0: s.x0, y0: s.y0, larg: s.larg, alt: s.alt, entrada: { ...s.entrada }, saida: { ...s.saida } })) };
    }
  }

  /* ----------------------------------------------------------------- jogo */
  const Fase = Object.freeze({ ROLAR: "rolar", MOVER: "mover", PALPITE: "palpite", REFUTANDO: "refutando", POS_PALPITE: "pos_palpite", FIM: "fim" });

  class Jogo {
    constructor(jogadores, pacote = BOA_ESPERANCA, rng = null) {
      jogadores = [...jogadores];
      if (jogadores.length < MIN_JOGADORES || jogadores.length > MAX_JOGADORES)
        throw new ErroJogo(`O jogo é de ${MIN_JOGADORES} a ${MAX_JOGADORES} jogadores.`);
      if (jogadores.some(n => !String(n).trim())) throw new ErroJogo("Todo jogador precisa de um nome.");
      if (new Set(jogadores).size !== jogadores.length) throw new ErroJogo("Não pode ter dois jogadores com o mesmo nome.");

      this.pacote = pacote; this.mapa = new Mapa(pacote); this.rng = rng || rngSeguro(); this.jogadores = jogadores;
      this.solucao = [this.rng.choice(pacote.suspeitos), this.rng.choice(pacote.locais), this.rng.choice(pacote.armas)];
      let restantes = todasAsCartas(pacote).filter(c => !this.solucao.includes(c));
      this.rng.shuffle(restantes);
      this.publicas = [];
      if (jogadores.length === 2) { this.publicas = restantes.slice(0, 4); restantes = restantes.slice(4); }
      this.maos = Object.fromEntries(jogadores.map(j => [j, []]));
      restantes.forEach((carta, i) => this.maos[jogadores[i % jogadores.length]].push(carta));

      // Cada jogador sorteia um personagem (um dos suspeitos) como peão.
      const personagens = [...pacote.suspeitos]; this.rng.shuffle(personagens);
      this.personagens = Object.fromEntries(jogadores.map((j, i) => [j, personagens[i]]));

      this.posicoes = Object.fromEntries(jogadores.map(j => [j, pacote.localInicial]));
      this.eliminados = new Set(); this.turno = 0; this.fase = Fase.ROLAR; this.dados = null; this.restantes = 0; this.ultimoLocal = {};
      this.palpite = null; this.refutador = null; this.opcoesRefutacao = []; this.filaRefutacao = [];
      this.encerrarAposRefutacao = false; this.vencedor = null; this.eventos = [];
    }

    get jogadorDaVez() { return this.jogadores[this.turno]; }

    _evento(tipo, dados = {}, soPara = null) { this.eventos.push({ n: this.eventos.length + 1, tipo, so_para: soPara, ...dados }); }
    _checar(nome) { if (!(nome in this.maos)) throw new ErroJogo("Jogador desconhecido."); }
    _exigir(nome, ...fases) {
      this._checar(nome);
      if (this.fase === Fase.FIM) throw new ErroJogo("A partida já terminou.");
      if (nome !== this.jogadorDaVez) throw new ErroJogo(`Não é a sua vez. Agora joga ${this.jogadorDaVez}.`);
      if (!fases.includes(this.fase)) throw new ErroJogo("Você não pode fazer isso agora.");
    }
    _ocupadasPorOutros(nome) {
      return new Set(Object.entries(this.posicoes).filter(([j]) => j !== nome && !this.eliminados.has(j)).map(([, p]) => p));
    }

    /* Rola dois dados: a soma é quantas casas dá para andar neste turno. */
    rolarDados(nome) {
      this._exigir(nome, Fase.ROLAR);
      this.dados = [this.rng.int(1, 6), this.rng.int(1, 6)]; this.restantes = this.dados[0] + this.dados[1];
      this.fase = Fase.MOVER;
      this._evento("dados", { jogador: nome, dados: [...this.dados] });
      return this.dados;
    }
    /* Casas e locais que o jogador da vez pode alcançar agora (até a soma dos dados). */
    opcoesMovimento(nome) {
      if (this.fase !== Fase.MOVER || nome !== this.jogadorDaVez || !this.dados) return [];
      const origem = this.posicoes[nome];
      const alcance = this.mapa.alcancaveis(origem, this.restantes, this._ocupadasPorOutros(nome));
      const proibido = this.ultimoLocal[nome];
      return [...alcance.keys()].sort().filter(c => !(c === origem && !this.mapa.ehLocal(origem)) && c !== proibido);
    }
    mover(nome, destino) {
      this._exigir(nome, Fase.MOVER);
      if (!this.opcoesMovimento(nome).includes(destino)) throw new ErroJogo("Você não consegue chegar lá neste turno.");
      const gasto = this.mapa.alcancaveis(this.posicoes[nome], this.restantes, this._ocupadasPorOutros(nome)).get(destino);
      this.posicoes[nome] = destino;
      this.restantes = Math.max(0, this.restantes - (Number.isFinite(gasto) ? gasto : this.restantes));
      this._evento("movimento", { jogador: nome, destino });
      if (this.mapa.ehLocal(destino)) { this.fase = Fase.PALPITE; this.restantes = 0; }
      else if (this.restantes <= 0 || !this.opcoesMovimento(nome).length) { this.fase = Fase.POS_PALPITE; this.restantes = 0; }
      // senão continua em MOVER: o jogador escolhe andar mais ou parar
    }
    /* Acabou o tempo da vez: passa a vez (ou mostra a primeira carta, se estava refutando). */
    tempoEsgotado() {
      if (this.fase === Fase.FIM) return;
      if (this.fase === Fase.REFUTANDO) { const q = this.refutador; this._evento("tempo_esgotado", { jogador: q }); this.mostrarCarta(q, this.opcoesRefutacao[0]); return; }
      const q = this.jogadorDaVez; this._evento("tempo_esgotado", { jogador: q }); this.encerrarAposRefutacao = false; this._proximoTurno();
    }
    /* Parar na rua com casas sobrando. */
    pararAqui(nome) {
      this._exigir(nome, Fase.MOVER);
      if (this.mapa.ehLocal(this.posicoes[nome])) throw new ErroJogo("Para ficar no local, toque nele.");
      this.restantes = 0; this.fase = Fase.POS_PALPITE;
    }
    usarAtalho(nome) {
      this._exigir(nome, Fase.ROLAR);
      const origem = this.posicoes[nome];
      if (!this.mapa.atalhos.has(origem)) throw new ErroJogo("Não há atalho secreto neste local.");
      const destino = this.mapa.atalhos.get(origem);
      if (destino === this.ultimoLocal[nome]) throw new ErroJogo(`Você palpitou em ${destino} na última vez. Palpite em outro local.`);
      this.posicoes[nome] = destino;
      this._evento("atalho", { jogador: nome, origem, destino });
      this.fase = Fase.PALPITE;
    }
    palpitar(nome, suspeito, arma) {
      this._exigir(nome, Fase.PALPITE);
      if (!this.pacote.suspeitos.includes(suspeito)) throw new ErroJogo("Suspeito inválido.");
      if (!this.pacote.armas.includes(arma)) throw new ErroJogo("Arma inválida.");
      const local = this.posicoes[nome];
      if (local === this.ultimoLocal[nome]) throw new ErroJogo(`Você já palpitou em ${local} na última vez. Palpite em outro local.`);
      this.ultimoLocal[nome] = local;
      this.palpite = { jogador: nome, suspeito, local, arma };
      this._evento("palpite", { ...this.palpite });
      // Como no jogo de tabuleiro: o suspeito citado é levado para o local do palpite.
      for (const outro of this.jogadores) {
        if (outro !== nome && !this.eliminados.has(outro) && this.personagens[outro] === suspeito && this.posicoes[outro] !== local) {
          this.posicoes[outro] = local; this._evento("convocado", { jogador: outro, personagem: suspeito, destino: local });
        }
      }
      const i = this.jogadores.indexOf(nome);
      this.filaRefutacao = [...this.jogadores.slice(i + 1), ...this.jogadores.slice(0, i)];
      this._seguirRefutacao();
    }
    _seguirRefutacao() {
      const p = this.palpite, cartas = [p.suspeito, p.local, p.arma];
      while (this.filaRefutacao.length) {
        const quem = this.filaRefutacao.shift();
        const tem = this.maos[quem].filter(c => cartas.includes(c));
        if (!tem.length) { this._evento("sem_carta", { jogador: quem }); continue; }
        if (tem.length === 1) { this._revelar(quem, tem[0]); return; }
        this.refutador = quem; this.opcoesRefutacao = [...tem].sort(); this.fase = Fase.REFUTANDO; return;
      }
      this._evento("ninguem_refutou"); this.fase = Fase.POS_PALPITE;
    }
    _revelar(quem, carta) {
      const palpiteiro = this.palpite.jogador;
      this._evento("carta_mostrada", { jogador: quem, para: palpiteiro });
      this._evento("carta_revelada", { jogador: quem, carta }, palpiteiro);
      this._evento("carta_que_mostrei", { jogador: quem, para: palpiteiro, carta }, quem);
      this.refutador = null; this.opcoesRefutacao = []; this.filaRefutacao = [];
      this.fase = Fase.POS_PALPITE;
      if (this.encerrarAposRefutacao) { this.encerrarAposRefutacao = false; this._proximoTurno(); }
    }
    mostrarCarta(nome, carta) {
      this._checar(nome);
      if (this.fase !== Fase.REFUTANDO) throw new ErroJogo("Ninguém precisa mostrar carta agora.");
      if (nome !== this.refutador) throw new ErroJogo(`Quem deve mostrar a carta é ${this.refutador}.`);
      if (!this.opcoesRefutacao.includes(carta)) throw new ErroJogo("Você só pode mostrar uma carta que combine com o palpite.");
      this._revelar(nome, carta);
    }
    acusar(nome, suspeito, local, arma) {
      this._exigir(nome, Fase.ROLAR, Fase.MOVER, Fase.PALPITE, Fase.POS_PALPITE);
      if (!this.pacote.suspeitos.includes(suspeito)) throw new ErroJogo("Suspeito inválido.");
      if (!this.pacote.locais.includes(local)) throw new ErroJogo("Local inválido.");
      if (!this.pacote.armas.includes(arma)) throw new ErroJogo("Arma inválida.");
      if (suspeito === this.solucao[0] && local === this.solucao[1] && arma === this.solucao[2]) {
        this._evento("acusacao_certa", { jogador: nome, suspeito, local, arma });
        this.vencedor = nome; this.fase = Fase.FIM; return true;
      }
      this._evento("acusacao_errada", { jogador: nome });
      this.eliminados.add(nome);
      const ativos = this.jogadores.filter(j => !this.eliminados.has(j));
      if (ativos.length <= 1) {
        this.vencedor = ativos[0] || null;
        this._evento("fim_por_eliminacao", { vencedor: this.vencedor }); this.fase = Fase.FIM;
      } else this._proximoTurno();
      return false;
    }
    encerrarTurno(nome) {
      this._exigir(nome, Fase.ROLAR, Fase.MOVER, Fase.POS_PALPITE, Fase.PALPITE);
      this._proximoTurno();
    }
    _proximoTurno() {
      const n = this.jogadores.length;
      for (let i = 0; i < n; i++) { this.turno = (this.turno + 1) % n; if (!this.eliminados.has(this.jogadorDaVez)) break; }
      this.fase = Fase.ROLAR; this.dados = null; this.restantes = 0; this.palpite = null;
      this._evento("vez_de", { jogador: this.jogadorDaVez });
    }
    /* Tira alguém da partida (saiu ou sumiu). As cartas dele continuam refutando. */
    remover(nome) {
      this._checar(nome);
      if (this.fase === Fase.FIM || this.eliminados.has(nome)) return;
      this.eliminados.add(nome); this._evento("removido", { jogador: nome });
      const ativos = this.jogadores.filter(j => !this.eliminados.has(j));
      if (ativos.length <= 1) {
        this.vencedor = ativos[0] || null; this._evento("fim_por_eliminacao", { vencedor: this.vencedor }); this.fase = Fase.FIM; return;
      }
      if (nome === this.jogadorDaVez) {
        if (this.fase === Fase.REFUTANDO) this.encerrarAposRefutacao = true; else this._proximoTurno();
      } else if (nome === this.refutador && this.fase === Fase.REFUTANDO) this._revelar(nome, this.opcoesRefutacao[0]);
    }

    /* Tudo o que `nome` pode saber agora. Nada além disso. */
    visaoPara(nome) {
      this._checar(nome);
      const fim = this.fase === Fase.FIM;
      return {
        voce: nome,
        jogadores: this.jogadores.map(j => ({ nome: j, personagem: this.personagens[j], posicao: this.posicoes[j], eliminado: this.eliminados.has(j), num_cartas: this.maos[j].length })),
        sua_mao: [...this.maos[nome]].sort(),
        cartas_publicas: [...this.publicas],
        vez_de: this.jogadorDaVez, fase: this.fase,
        dados: this.dados ? [...this.dados] : null, restantes: this.restantes || 0, ultimo_palpite_local: this.ultimoLocal[nome] || null,
        palpite_atual: this.palpite ? { ...this.palpite } : null,
        aguardando_carta_de: this.refutador,
        cartas_que_pode_mostrar: nome === this.refutador ? [...this.opcoesRefutacao] : [],
        opcoes_movimento: this.opcoesMovimento(nome),
        tem_atalho: this.fase === Fase.ROLAR && nome === this.jogadorDaVez && this.mapa.atalhos.has(this.posicoes[nome]) && this.mapa.atalhos.get(this.posicoes[nome]) !== this.ultimoLocal[nome],
        eventos: this.eventos.filter(e => e.so_para === null || e.so_para === nome),
        vencedor: this.vencedor,
        solucao: fim ? [...this.solucao] : null,
      };
    }

    /* Para guardar a partida e retomar se o app do juiz fechar. */
    serializar() {
      return {
        pacote: this.pacote.id, jogadores: this.jogadores, solucao: this.solucao, publicas: this.publicas, maos: this.maos,
        posicoes: this.posicoes, eliminados: [...this.eliminados], turno: this.turno, fase: this.fase, dados: this.dados, restantes: this.restantes || 0, ultimoLocal: this.ultimoLocal,
        personagens: this.personagens,
        palpite: this.palpite, refutador: this.refutador, opcoesRefutacao: this.opcoesRefutacao, filaRefutacao: this.filaRefutacao,
        encerrarAposRefutacao: this.encerrarAposRefutacao, vencedor: this.vencedor, eventos: this.eventos,
      };
    }
    static restaurar(o, rng = null) {
      const pacote = PACOTES[o.pacote];
      if (!pacote) throw new ErroJogo("Cenário desconhecido.");
      const j = Object.create(Jogo.prototype);
      Object.assign(j, {
        pacote, mapa: new Mapa(pacote), rng: rng || rngSeguro(), jogadores: o.jogadores, solucao: o.solucao, publicas: o.publicas,
        maos: o.maos, posicoes: o.posicoes, eliminados: new Set(o.eliminados), turno: o.turno, fase: o.fase === "inicio" || (o.fase === "mover" && !o.dados) ? Fase.ROLAR : o.fase, dados: o.dados || null, ultimoLocal: o.ultimoLocal || {}, restantes: o.restantes != null ? o.restantes : (o.fase === "mover" && o.dados ? o.dados[0] + o.dados[1] : 0),
        personagens: o.personagens || {},
        palpite: o.palpite, refutador: o.refutador, opcoesRefutacao: o.opcoesRefutacao, filaRefutacao: o.filaRefutacao,
        encerrarAposRefutacao: o.encerrarAposRefutacao, vencedor: o.vencedor, eventos: o.eventos,
      });
      // Compatibilidade com partidas salvas em versões anteriores
      j.personagens = o.personagens || Object.fromEntries(o.jogadores.map((n, i) => [n, pacote.suspeitos[i % pacote.suspeitos.length]]));
      for (const n of o.jogadores) if (!j.mapa.valido(j.posicoes[n])) j.posicoes[n] = pacote.localInicial;
      return j;
    }
  }

  return { MIN_JOGADORES, MAX_JOGADORES, ErroJogo, Fase, Jogo, Mapa, BOA_ESPERANCA, COLEGIO, HOTEL, PACOTES, todasAsCartas, rngSeguro, rngComSemente };
});
