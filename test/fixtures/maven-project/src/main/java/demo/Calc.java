package demo;
public class Calc {
    public int add(int a, int b) { return a + b; }
    public int clampScore(int r) { return Math.max(0, Math.min(100, r)); }
}
