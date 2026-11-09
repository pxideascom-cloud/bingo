"""Server-owned Ludo rules: two opposite colors or all four colors."""

from dataclasses import dataclass, field
import secrets
import time

from game import GameError


COLORS = ("red", "green", "yellow", "blue")
STARTS = {color: index * 13 for index, color in enumerate(COLORS)}
FINISH = 56
SAFE_SQUARES = frozenset((0, 8, 13, 21, 26, 34, 39, 47))
TRACK = (
    [(6, col) for col in range(1, 6)]
    + [(row, 6) for row in range(5, -1, -1)] + [(0, 7), (0, 8)]
    + [(row, 8) for row in range(1, 6)]
    + [(6, col) for col in range(9, 15)] + [(7, 14), (8, 14)]
    + [(8, col) for col in range(13, 8, -1)]
    + [(row, 8) for row in range(9, 15)] + [(14, 7), (14, 6)]
    + [(row, 6) for row in range(13, 8, -1)]
    + [(8, col) for col in range(5, -1, -1)] + [(7, 0), (6, 0)]
)
HOME_LANES = {
    "red": [(7, col) for col in range(1, 7)],
    "green": [(row, 7) for row in range(1, 7)],
    "yellow": [(7, col) for col in range(13, 7, -1)],
    "blue": [(row, 7) for row in range(13, 7, -1)],
}
YARDS = {
    "red": [(2, 2), (2, 4), (4, 2), (4, 4)],
    "green": [(2, 10), (2, 12), (4, 10), (4, 12)],
    "yellow": [(10, 10), (10, 12), (12, 10), (12, 12)],
    "blue": [(10, 2), (10, 4), (12, 2), (12, 4)],
}


def board_layout() -> dict:
    return {"track": TRACK, "safe_squares": sorted(SAFE_SQUARES),
            "starts": STARTS, "home_lanes": HOME_LANES, "yards": YARDS}


@dataclass
class LudoPlayer:
    name: str
    color: str
    id: str = field(default_factory=lambda: secrets.token_hex(8))
    token: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    tokens: list[int] = field(default_factory=lambda: [-1] * 4)
    connected: bool = False
    ready: bool = False
    rematch: bool = False
    disconnected_at: float = field(default_factory=time.monotonic)


@dataclass
class LudoRoom:
    code: str
    player_count: int = 2
    players: list[LudoPlayer] = field(default_factory=list)
    phase: str = "waiting"
    turn_id: str | None = None
    dice: int | None = None
    last_roll: int | None = None
    last_roll_player_id: str | None = None
    six_streak: int = 0
    rolls: int = 0
    winner_ids: list[str] = field(default_factory=list)
    standings: dict[str, dict] = field(default_factory=dict)
    results: list[dict] = field(default_factory=list)
    round: int = 1
    revision: int = 0
    notice: str = ""
    last_action: str = "Invite your friends and get ready."
    updated_at: float = field(default_factory=time.monotonic)

    def __post_init__(self):
        if type(self.player_count) is not int or self.player_count not in (2, 4):
            raise GameError("Choose a two-player or four-player Ludo room.")

    @property
    def colors(self):
        return ("red", "yellow") if self.player_count == 2 else COLORS

    @property
    def paused(self):
        return self.phase == "playing" and not all(p.connected for p in self.players)

    def touch(self):
        self.revision += 1
        self.updated_at = time.monotonic()

    def add_player(self, name: str) -> LudoPlayer:
        if len(self.players) >= self.player_count:
            raise GameError("This room is full. Create a new room for your game.")
        if self.phase != "waiting":
            raise GameError("This game has already started.")
        if any(p.name.casefold() == name.casefold() for p in self.players):
            raise GameError("That name is already taken in this room. Try another.")
        color = next(color for color in self.colors if all(p.color != color for p in self.players))
        player = LudoPlayer(name=name, color=color)
        self.players.append(player)
        self.players.sort(key=lambda p: self.colors.index(p.color))
        self.standings[player.id] = {"id": player.id, "name": name, "color": color, "wins": 0}
        self.notice = ""
        self.touch()
        return player

    def authenticate(self, token: str) -> LudoPlayer:
        for player in self.players:
            if secrets.compare_digest(player.token.encode(), token.encode()):
                return player
        raise GameError("Your seat has expired. Please join the room again.")

    def maybe_start(self):
        if self.phase == "waiting" and len(self.players) == self.player_count and all(
            p.ready and p.connected for p in self.players
        ):
            self.phase = "playing"
            self.turn_id = self.players[(self.round - 1) % self.player_count].id
            self.last_action = "Everyone is ready. Roll the dice to begin."

    def connect(self, player: LudoPlayer):
        player.connected = True
        self.maybe_start()
        self.touch()

    def disconnect(self, player: LudoPlayer):
        player.connected = False
        player.disconnected_at = time.monotonic()
        self.touch()

    def remove_player(self, player: LudoPlayer):
        self.players.remove(player)
        self.round += 1
        self.reset()
        self.notice = f"{player.name} left. Invite someone to fill the open seat."
        self.touch()

    def reset(self):
        self.phase = "waiting"
        self.turn_id = None
        self.dice = self.last_roll = self.last_roll_player_id = None
        self.six_streak = self.rolls = 0
        self.winner_ids.clear()
        self.notice = ""
        self.last_action = "A new round. Get everyone ready."
        for player in self.players:
            player.tokens = [-1] * 4
            player.ready = player.rematch = False

    def token_cell(self, player: LudoPlayer, index: int):
        progress = player.tokens[index]
        if progress < 0:
            return YARDS[player.color][index]
        if progress <= 50:
            return TRACK[(STARTS[player.color] + progress) % len(TRACK)]
        return HOME_LANES[player.color][progress - 51]

    def legal_moves(self, player: LudoPlayer, dice: int | None) -> list[int]:
        if dice is None:
            return []
        return [index for index, progress in enumerate(player.tokens)
                if (progress == -1 and dice == 6)
                or (0 <= progress < FINISH and progress + dice <= FINISH)]

    def require_turn(self, player: LudoPlayer):
        if self.phase != "playing":
            raise GameError("The game is not in progress.")
        if self.paused:
            raise GameError("The game is paused while a player reconnects.")
        if player.id != self.turn_id:
            raise GameError("Wait for your turn.")

    def end_turn(self, extra: bool = False):
        self.dice = None
        if not extra:
            index = next(i for i, p in enumerate(self.players) if p.id == self.turn_id)
            self.turn_id = self.players[(index + 1) % self.player_count].id
            self.six_streak = 0

    def roll(self, player: LudoPlayer):
        self.require_turn(player)
        if self.dice is not None:
            raise GameError("Choose a token before rolling again.")
        self.dice = secrets.randbelow(6) + 1
        self.last_roll = self.dice
        self.last_roll_player_id = player.id
        self.rolls += 1
        self.six_streak = self.six_streak + 1 if self.dice == 6 else 0
        if self.six_streak == 3:
            self.last_action = f"{player.name} rolled three sixes in a row. The turn passes."
            self.end_turn()
        elif not self.legal_moves(player, self.dice):
            self.last_action = f"{player.name} rolled {self.dice}. No token can move."
            extra = self.dice == 6
            self.end_turn(extra=extra)
            if extra:
                self.last_action += " Roll again."
        else:
            self.last_action = f"{player.name} rolled {self.dice}. Choose a highlighted token."

    def move(self, player: LudoPlayer, index):
        self.require_turn(player)
        if self.dice is None:
            raise GameError("Roll the dice first.")
        if type(index) is not int or index not in self.legal_moves(player, self.dice):
            raise GameError("Choose one of your highlighted tokens.")
        dice = self.dice
        player.tokens[index] = 0 if player.tokens[index] == -1 else player.tokens[index] + dice
        progress = player.tokens[index]
        captures = 0
        if progress <= 50:
            landing = (STARTS[player.color] + progress) % len(TRACK)
            if landing not in SAFE_SQUARES:
                for rival in self.players:
                    if rival.id == player.id:
                        continue
                    for rival_index, rival_progress in enumerate(rival.tokens):
                        if 0 <= rival_progress <= 50 and (STARTS[rival.color] + rival_progress) % len(TRACK) == landing:
                            rival.tokens[rival_index] = -1
                            captures += 1
        self.last_action = f"{player.name} moved token {index + 1}."
        if captures:
            self.last_action += f" Captured {captures} token{'s' if captures != 1 else ''}!"
        if progress == FINISH:
            self.last_action += " A token reached home!"
        if all(value == FINISH for value in player.tokens):
            self.phase = "finished"
            self.winner_ids = [player.id]
            self.standings[player.id]["wins"] += 1
            self.results.append({"round": self.round, "winner_id": player.id,
                                 "winner_name": player.name, "rolls": self.rolls})
            self.turn_id = self.dice = None
            self.last_action = f"{player.name} brought all four tokens home and won!"
        else:
            extra = dice == 6 or captures > 0 or progress == FINISH
            self.end_turn(extra=extra)
            if extra:
                self.last_action += " Roll again."

    def act(self, player: LudoPlayer, message: dict):
        action = message.get("type")
        if action == "ready":
            if self.phase != "waiting":
                raise GameError("The game has already started.")
            if type(message.get("ready")) is not bool:
                raise GameError("Choose whether you are ready.")
            player.ready = message["ready"]
            self.maybe_start()
        elif action == "roll":
            self.roll(player)
        elif action == "move":
            self.move(player, message.get("token_index"))
        elif action == "rematch":
            if self.phase != "finished":
                raise GameError("Finish this game before starting another.")
            player.rematch = True
            if len(self.players) == self.player_count and all(p.rematch for p in self.players):
                self.round += 1
                self.reset()
        else:
            raise GameError("That action is not supported.")
        self.touch()

    def state_for(self, viewer: LudoPlayer) -> dict:
        return {
            "type": "state", "game": "ludo", "code": self.code,
            "player_count": self.player_count, "phase": self.phase,
            "round": self.round, "revision": self.revision, "you": viewer.id,
            "players": [{"id": p.id, "name": p.name, "color": p.color,
                         "connected": p.connected, "ready": p.ready, "rematch": p.rematch,
                         "wins": self.standings[p.id]["wins"],
                         "tokens": [{"index": i, "progress": progress, "cell": self.token_cell(p, i)}
                                    for i, progress in enumerate(p.tokens)]}
                        for p in self.players],
            "turn_id": self.turn_id, "dice": self.dice, "last_roll": self.last_roll,
            "last_roll_player_id": self.last_roll_player_id, "six_streak": self.six_streak,
            "legal_moves": self.legal_moves(viewer, self.dice)
                           if self.phase == "playing" and not self.paused and self.turn_id == viewer.id else [],
            "winner_ids": self.winner_ids[:], "paused": self.paused,
            "standings": [record.copy() for record in self.standings.values()],
            "results": [result.copy() for result in self.results],
            "notice": self.notice, "last_action": self.last_action, "layout": board_layout(),
        }
