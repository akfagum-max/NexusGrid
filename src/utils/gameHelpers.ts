// Game constants
export const SYMBOLS = ['X', 'O', '▲', '■', '◆', '★'];
export const COLORS = [
  '#00f0ff', // Neon Blue
  '#ff007f', // Neon Pink
  '#39ff14', // Neon Green
  '#bd00ff', // Neon Purple
  '#ff9900', // Neon Orange
  '#fffb00'  // Neon Yellow
];

/**
 * Checks if a player has won the game.
 * Board size is (N+1)x(N+1) where N is number of players.
 * To win, a player needs to get (N+1) marks in a straight row, column, or diagonal.
 */
export function checkWin(board: (string | null)[], size: number, symbol: string): number[] | null {
  // Row check
  for (let r = 0; r < size; r++) {
    let win = true;
    const line: number[] = [];
    for (let c = 0; c < size; c++) {
      const idx = r * size + c;
      if (board[idx] !== symbol) {
        win = false;
        break;
      }
      line.push(idx);
    }
    if (win) return line;
  }

  // Column check
  for (let c = 0; c < size; c++) {
    let win = true;
    const line: number[] = [];
    for (let r = 0; r < size; r++) {
      const idx = r * size + c;
      if (board[idx] !== symbol) {
        win = false;
        break;
      }
      line.push(idx);
    }
    if (win) return line;
  }

  // Main diagonal
  let diag1Win = true;
  const diag1Line: number[] = [];
  for (let i = 0; i < size; i++) {
    const idx = i * size + i;
    if (board[idx] !== symbol) {
      diag1Win = false;
      break;
    }
    diag1Line.push(idx);
  }
  if (diag1Win) return diag1Line;

  // Anti-diagonal
  let diag2Win = true;
  const diag2Line: number[] = [];
  for (let i = 0; i < size; i++) {
    const idx = i * size + (size - 1 - i);
    if (board[idx] !== symbol) {
      diag2Win = false;
      break;
    }
    diag2Line.push(idx);
  }
  if (diag2Win) return diag2Line;

  return null;
}
