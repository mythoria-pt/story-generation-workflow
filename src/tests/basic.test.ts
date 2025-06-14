import { describe, it, expect } from '@jest/globals';

describe('Basic functionality', () => {
  it('should perform basic arithmetic', () => {
    expect(2 + 2).toBe(4);
  });

  it('should handle string operations', () => {
    expect('hello').toBe('hello');
  });

  it('should work with objects', () => {
    const obj = { name: 'test', value: 42 };
    expect(obj.name).toBe('test');
    expect(obj.value).toBe(42);
  });
});

describe('Environment', () => {
  it('should have NODE_ENV set', () => {
    expect(process.env.NODE_ENV).toBeDefined();
  });
});
