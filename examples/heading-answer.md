Для RTX я бы использовал **стабильный LSD radix sort с radix 256, подгруппами по 32 потока и предварительной перестановкой элементов в shared memory**.

Важная оговорка: «максимальная эффективность» зависит от модели RTX, размера массива и формата данных. Без измерений нельзя честно назвать конкретную реализацию самой быстрой. Ниже — **NVIDIA-ориентированная реализация без глобальных атомиков на каждый элемент и без опасного межгруппового spin-wait**.

## Предположения:

*   ключи — `uint32_t`;
*   значения — опциональные `uint32_t`, например индексы исходных элементов;
*   сортировка стабильная, по возрастанию;
*   данные уже находятся на GPU;
*   Vulkan 1.3;
*   доступен `VK_NV_shader_subgroup_partitioned`;
*   размер subgroup зафиксирован на **32**.

Шейдеры приведены полностью. Vulkan-обвязка — в виде псевдокода, поскольку создание буферов, дескрипторов и pipeline обычно уже реализовано в движке.

# 1\. Алгоритм

## За один проход обрабатываются 8 бит ключа. Всего четыре прохода:

```
shift = 0, 8, 16, 24
```

## Каждый проход:

```
Histogram
    ↓
Exclusive prefix scan гистограммы
    ↓
Stable scatter
```

text

## Параметры:

```
WORKGROUP_SIZE = 256;
SUBGROUP_SIZE  = 32;
ITEMS_PER_THREAD = 4;
TILE_SIZE = 1024;
RADIX = 256;
```

cpp

Одна workgroup обрабатывает 1024 элемента.

## Гистограмма хранится в bin-major порядке:

```
H[bin * groupCount + group]
```

## Если выполнить exclusive scan всего этого массива, получим сразу:

```
P[bin * groupCount + group]
    = количество элементов во всех предыдущих bin
    + количество элементов этого bin в предыдущих workgroup
```

text

То есть отдельный проход для вычисления глобального начала каждого bin не нужен.

## В scatter используются:

1.  1.`subgroupPartitionNV()` для нахождения одинаковых digit внутри warp;
2.  2.один shared atomic на группу одинаковых digit, а не обязательно на каждый элемент;
3.  3.стабильные локальные ранги;
4.  4.перестановка в shared memory;
5.  5.запись в глобальную память в локально отсортированном порядке.

Последний пункт существенно улучшает характер глобальных записей.

# 2\. Общий файл `radix_common.glsl`

Все шейдеры должны компилироваться с поддержкой include, например через `glslangValidator`.

```
#ifndef RADIX_COMMON_GLSL
#define RADIX_COMMON_GLSL

#extension GL_KHR_shader_subgroup_basic      : require
#extension GL_KHR_shader_subgroup_arithmetic : require
#extension GL_KHR_shader_subgroup_ballot     : require
#extension GL_KHR_shader_subgroup_shuffle    : require
#extension GL_NV_shader_subgroup_partitioned : require
#extension GL_EXT_control_flow_attributes    : require

const uint WG_SIZE = 256u;
const uint WARP_SIZE = 32u;
const uint WARP_COUNT = 8u;

const uint ITEMS = 4u;
const uint TILE_SIZE = 1024u;
const uint BIN_COUNT = 256u;

layout(local_size_x = 256, local_size_y = 1, local_size_z = 1) in;

// Не предполагаем конкретное соответствие LocalInvocationIndex
// и порядка invocation внутри subgroup.
uint logicalThreadID()
{
    return gl_SubgroupID * WARP_SIZE + gl_SubgroupInvocationID;
}

// Позволяет использовать двумерный dispatch для больших массивов.
uint linearGroupID()
{
    return gl_WorkGroupID.x
         + gl_NumWorkGroups.x * gl_WorkGroupID.y;
}

// По умолчанию сортируются беззнаковые 32-битные ключи.
uint orderedKey(uint raw)
{
    return raw;
}

uint keyDigit(uint raw, uint shift)
{
    return (orderedKey(raw) >> shift) & 255u;
}

shared uint scanWarpOffsets[8];

// Все invocation workgroup обязаны вызвать эту функцию.
// Порядок сканирования:
// subgroup 0, lanes 0..31; subgroup 1, lanes 0..31; ...
uint workgroupExclusiveAdd(uint value)
{
    uint lane = gl_SubgroupInvocationID;
    uint warp = gl_SubgroupID;

    uint localPrefix = subgroupExclusiveAdd(value);
    uint warpTotal = subgroupAdd(value);

    if (lane == 0u)
        scanWarpOffsets[warp] = warpTotal;

    barrier();

    if (warp == 0u)
    {
        uint x = 0u;

        if (lane < WARP_COUNT)
            x = scanWarpOffsets[lane];

        uint prefix = subgroupExclusiveAdd(x);

        if (lane < WARP_COUNT)
            scanWarpOffsets[lane] = prefix;
    }

    barrier();

    return localPrefix + scanWarpOffsets[warp];
}

#endif
```

glsl

# 3\. Гистограмма: `radix_histogram.comp`

## Дескрипторы:

Binding

Данные

0

Входные ключи

1

Гистограмма

```
#version 460
#extension GL_GOOGLE_include_directive : require

#include "radix_common.glsl"

layout(set = 0, binding = 0, std430)
readonly buffer InputKeys
{
    uint inputKeys[];
};

layout(set = 0, binding = 1, std430)
writeonly buffer Histogram
{
    uint histogram[];
};

layout(push_constant) uniform Push
{
    uint count;
    uint shift;
    uint groupCount;
} pc;

shared uint localHistogram[256];

void main()
{
    uint group = linearGroupID();

    // Условие одинаково для всей workgroup.
    if (group >= pc.groupCount)
        return;

    uint tid = logicalThreadID();
    uint warp = gl_SubgroupID;
    uint lane = gl_SubgroupInvocationID;

    localHistogram[tid] = 0u;

    barrier();

    uint tileBase = group * TILE_SIZE;

    // Каждому warp принадлежит непрерывный участок из 128 ключей.
    [[unroll]]
    for (uint item = 0u; item < ITEMS; ++item)
    {
        uint index = tileBase
                   + warp * (WARP_SIZE * ITEMS)
                   + item * WARP_SIZE
                   + lane;

        bool valid = index < pc.count;

        uint key = 0u;

        if (valid)
            key = inputKeys[index];

        uint digit = keyDigit(key, pc.shift);

        uvec4 validMask = subgroupBallot(valid);
        uvec4 peers = subgroupPartitionNV(digit) & validMask;

        uint peerCount = subgroupBallotBitCount(peers);
        uint leader = 0u;

        if (peerCount != 0u)
            leader = subgroupBallotFindLSB(peers);

        if (valid && lane == leader)
            atomicAdd(localHistogram[digit], peerCount);
    }

    barrier();

    histogram[tid * pc.groupCount + group] = localHistogram[tid];
}
```

glsl

Для одинаковых ключей вместо 32 shared atomic на warp выполняется один.

При равномерном распределении digit выигрыш от объединения меньше, но сохраняется отсутствие глобальных атомиков на каждый ключ.

# 4\. Иерархический exclusive scan

## Нужен scan массива длиной:

```
histogramLength = 256 * groupCount;
```

Ниже одна workgroup сканирует до **1024 чисел**.

Вход и выход представлены как `uvec4[]`. Поэтому **каждый буфер scan должен иметь физический размер, округлённый вверх до четырёх `uint`**, включая буферы промежуточных сумм.

Логическая длина передаётся отдельно.

## `scan_blocks.comp`

Binding

Данные

0

Вход scan

1

Локальные exclusive prefix

2

Сумма каждого блока

```
#version 460
#extension GL_GOOGLE_include_directive : require

#include "radix_common.glsl"

layout(set = 0, binding = 0, std430)
readonly buffer ScanInput
{
    uvec4 inputVectors[];
};

layout(set = 0, binding = 1, std430)
writeonly buffer ScanOutput
{
    uvec4 outputVectors[];
};

layout(set = 0, binding = 2, std430)
writeonly buffer BlockSums
{
    uint blockSums[];
};

layout(push_constant) uniform Push
{
    uint count;
} pc;

void main()
{
    uint group = linearGroupID();
    uint blockBase = group * TILE_SIZE;

    if (blockBase >= pc.count)
        return;

    uint tid = logicalThreadID();

    uint vectorIndex = group * WG_SIZE + tid;
    uint scalarIndex = vectorIndex * 4u;

    uvec4 v = uvec4(0u);

    if (scalarIndex < pc.count)
    {
        // Физически буфер дополнен до кратности четырём uint.
        v = inputVectors[vectorIndex];

        if (scalarIndex + 1u >= pc.count) v.y = 0u;
        if (scalarIndex + 2u >= pc.count) v.z = 0u;
        if (scalarIndex + 3u >= pc.count) v.w = 0u;
    }

    uint total = v.x + v.y + v.z + v.w;
    uint prefix = workgroupExclusiveAdd(total);

    uvec4 result = uvec4(
        prefix,
        prefix + v.x,
        prefix + v.x + v.y,
        prefix + v.x + v.y + v.z
    );

    if (scalarIndex < pc.count)
        outputVectors[vectorIndex] = result;

    if (tid == WG_SIZE - 1u)
        blockSums[group] = prefix + total;
}
```

glsl

## `scan_add.comp`

После рекурсивного scan сумм блоков добавляем соответствующее смещение каждому блоку.

Binding

Данные

0

Результат нижнего уровня, read/write

1

Exclusive prefix сумм блоков

```
#version 460
#extension GL_GOOGLE_include_directive : require

#include "radix_common.glsl"

layout(set = 0, binding = 0, std430)
buffer ScanData
{
    uvec4 vectors[];
};

layout(set = 0, binding = 1, std430)
readonly buffer ParentPrefixes
{
    uint parentPrefixes[];
};

layout(push_constant) uniform Push
{
    uint count;
} pc;

void main()
{
    uint group = linearGroupID();
    uint tid = logicalThreadID();

    uint vectorIndex = group * WG_SIZE + tid;
    uint scalarIndex = vectorIndex * 4u;

    if (scalarIndex >= pc.count)
        return;

    uint offset = parentPrefixes[group];

    vectors[vectorIndex] += uvec4(offset);
}
```

glsl

# 5\. Стабильный scatter: `radix_scatter.comp`

## Можно собрать две версии:

```
WITH_VALUES=0 — только ключи
WITH_VALUES=1 — пары uint key + uint value
```

text

## Дескрипторы:

Binding

Данные

0

Входные ключи

1

Входные значения, если включены

2

Выходные ключи

3

Выходные значения, если включены

4

Глобальный exclusive prefix гистограммы

```
#version 460
#extension GL_GOOGLE_include_directive : require

#ifndef WITH_VALUES
#define WITH_VALUES 1
#endif

#include "radix_common.glsl"

layout(set = 0, binding = 0, std430)
readonly buffer InputKeys
{
    uint inputKeys[];
};

#if WITH_VALUES
layout(set = 0, binding = 1, std430)
readonly buffer InputValues
{
    uint inputValues[];
};
#endif

layout(set = 0, binding = 2, std430)
writeonly buffer OutputKeys
{
    uint outputKeys[];
};

#if WITH_VALUES
layout(set = 0, binding = 3, std430)
writeonly buffer OutputValues
{
    uint outputValues[];
};
#endif

layout(set = 0, binding = 4, std430)
readonly buffer HistogramPrefixes
{
    uint histogramPrefixes[];
};

layout(push_constant) uniform Push
{
    uint count;
    uint shift;
    uint groupCount;
} pc;

// Сначала: количество элементов каждого digit внутри warp.
// Затем: exclusive prefix этого количества по warp.
shared uint warpHistogram[8 * 256];

shared uint binLocalStart[256];
shared uint binGlobalStart[256];

shared uint sortedKeys[1024];

#if WITH_VALUES
shared uint sortedValues[1024];
#endif

void main()
{
    uint group = linearGroupID();

    if (group >= pc.groupCount)
        return;

    uint tid = logicalThreadID();
    uint warp = gl_SubgroupID;
    uint lane = gl_SubgroupInvocationID;

    [[unroll]]
    for (uint w = 0u; w < WARP_COUNT; ++w)
        warpHistogram[w * BIN_COUNT + tid] = 0u;

    barrier();

    uint tileBase = group * TILE_SIZE;
    uint tileCount = min(TILE_SIZE, pc.count - tileBase);

    uint keys[4];
    uint digits[4];
    uint ranks[4];

#if WITH_VALUES
    uint values[4];
#endif

    // ------------------------------------------------------------
    // 1. Стабильные ранги внутри каждого warp.
    // ------------------------------------------------------------

    [[unroll]]
    for (uint item = 0u; item < ITEMS; ++item)
    {
        uint localIndex = warp * (WARP_SIZE * ITEMS)
                        + item * WARP_SIZE
                        + lane;

        uint index = tileBase + localIndex;
        bool valid = localIndex < tileCount;

        uint key = 0u;

        if (valid)
            key = inputKeys[index];

        keys[item] = key;

#if WITH_VALUES
        uint value = 0u;

        if (valid)
            value = inputValues[index];

        values[item] = value;
#endif

        uint digit = keyDigit(key, pc.shift);
        digits[item] = digit;

        uvec4 validMask = subgroupBallot(valid);
        uvec4 peers = subgroupPartitionNV(digit) & validMask;

        uint peerCount = subgroupBallotBitCount(peers);
        uint leader = 0u;

        if (peerCount != 0u)
            leader = subgroupBallotFindLSB(peers);

        uint previousCount = 0u;

        if (valid && lane == leader)
        {
            previousCount = atomicAdd(
                warpHistogram[warp * BIN_COUNT + digit],
                peerCount
            );
        }

        previousCount = subgroupShuffle(previousCount, leader);

        ranks[item] = previousCount
                    + subgroupBallotExclusiveBitCount(peers);

        // Следующий item должен видеть завершённые обновления
        // предыдущего item, в том числе при смене leader.
        subgroupMemoryBarrierShared();
        subgroupBarrier();
    }

    barrier();

    // ------------------------------------------------------------
    // 2. Prefix по warp для каждого bin.
    // Один invocation обслуживает один bin.
    // ------------------------------------------------------------

    uint binTotal = 0u;

    [[unroll]]
    for (uint w = 0u; w < WARP_COUNT; ++w)
    {
        uint address = w * BIN_COUNT + tid;
        uint count = warpHistogram[address];

        warpHistogram[address] = binTotal;
        binTotal += count;
    }

    // Начало bin внутри локально отсортированного tile.
    uint localStart = workgroupExclusiveAdd(binTotal);

    binLocalStart[tid] = localStart;

    // Начало участка этой workgroup в глобальном bin.
    binGlobalStart[tid] =
        histogramPrefixes[tid * pc.groupCount + group];

    barrier();

    // ------------------------------------------------------------
    // 3. Стабильная перестановка в shared memory.
    // ------------------------------------------------------------

    [[unroll]]
    for (uint item = 0u; item < ITEMS; ++item)
    {
        uint localIndex = warp * (WARP_SIZE * ITEMS)
                        + item * WARP_SIZE
                        + lane;

        if (localIndex < tileCount)
        {
            uint digit = digits[item];

            uint position =
                binLocalStart[digit]
                + warpHistogram[warp * BIN_COUNT + digit]
                + ranks[item];

            sortedKeys[position] = keys[item];

#if WITH_VALUES
            sortedValues[position] = values[item];
#endif
        }
    }

    barrier();

    // ------------------------------------------------------------
    // 4. Читаем shared последовательно.
    // Внутри одного bin глобальные адреса последовательны.
    // ------------------------------------------------------------

    [[unroll]]
    for (uint item = 0u; item < ITEMS; ++item)
    {
        uint position = item * WG_SIZE + tid;

        if (position < tileCount)
        {
            uint key = sortedKeys[position];
            uint digit = keyDigit(key, pc.shift);

            uint destination =
                binGlobalStart[digit]
                + (position - binLocalStart[digit]);

            outputKeys[destination] = key;

#if WITH_VALUES
            outputValues[destination] = sortedValues[position];
#endif
        }
    }
}
```

glsl

### Почему scatter стабильный

## Порядок одинаковых digit сохраняется на всех уровнях:

```
предыдущие workgroup
    → предыдущие warp
        → предыдущие порции по 32 элемента
            → предыдущие lane
```

text

Следовательно, четыре LSD-прохода дают корректную сортировку полного 32-битного ключа.

# 6\. Vulkan-обвязка

## Требования к устройству

## Проверьте:

*   `VK_NV_shader_subgroup_partitioned`;
*   поддержку compute в `VkPhysicalDeviceSubgroupProperties::supportedStages`;
*   subgroup operations:
    
    *   `BASIC`;
    *   `ARITHMETIC`;
    *   `BALLOT`;
    *   `SHUFFLE`;
    *   `PARTITIONED_NV`;
    
*   поддержку workgroup из 256 invocation;
*   достаточный `maxComputeSharedMemorySize`.

## Для scatter требуется примерно:

```
key-only:    14 KiB shared memory
key-value:   18 KiB shared memory
```

text

**Размер subgroup = 32 является обязательным условием данного кода.**

## Предпочтительный вариант — включить `subgroupSizeControl` и `computeFullSubgroups`, проверить допустимость размера 32 для compute и создать pipeline с:

```
VkPipelineShaderStageRequiredSubgroupSizeCreateInfo subgroupInfo{
    VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_REQUIRED_SUBGROUP_SIZE_CREATE_INFO
};

subgroupInfo.requiredSubgroupSize = 32;

shaderStage.pNext = &subgroupInfo;
shaderStage.flags |=
    VK_PIPELINE_SHADER_STAGE_CREATE_REQUIRE_FULL_SUBGROUPS_BIT;
```

cpp

Также проверьте, что допускаются минимум восемь subgroup на compute workgroup. Если устройство использует фиксированные subgroup по 32, возможен соответствующий путь без size-control.

## Буферы

```
const uint64_t groupCount = (uint64_t(count) + 1023) / 1024;
const uint64_t histogramLength = groupCount * 256;

KeysA[count];
KeysB[count];

ValuesA[count]; // опционально
ValuesB[count];

Histogram[histogramLength];
HistogramPrefix[histogramLength];

// Дополнительно — небольшие буферы иерархического scan.
// Каждый физический размер округляется до кратности 4 uint.
```

cpp

Для всех используемых SSBO нужен `VK_BUFFER_USAGE_STORAGE_BUFFER_BIT`.

Вход и выход scatter **не должны перекрываться**.

Размеры буферов рассчитывайте на CPU в 64-битной арифметике. Для очень больших массивов дополнительно учитывайте `maxStorageBufferRange`.

## Compute barrier

## Между зависимыми dispatch:

```
void computeBarrier(VkCommandBuffer cmd)
{
    VkMemoryBarrier2 barrier{
        VK_STRUCTURE_TYPE_MEMORY_BARRIER_2
    };

    barrier.srcStageMask =
        VK_PIPELINE_STAGE_2_COMPUTE_SHADER_BIT;

    barrier.srcAccessMask =
        VK_ACCESS_2_SHADER_STORAGE_WRITE_BIT;

    barrier.dstStageMask =
        VK_PIPELINE_STAGE_2_COMPUTE_SHADER_BIT;

    barrier.dstAccessMask =
        VK_ACCESS_2_SHADER_STORAGE_READ_BIT |
        VK_ACCESS_2_SHADER_STORAGE_WRITE_BIT;

    VkDependencyInfo dependency{
        VK_STRUCTURE_TYPE_DEPENDENCY_INFO
    };

    dependency.memoryBarrierCount = 1;
    dependency.pMemoryBarriers = &barrier;

    vkCmdPipelineBarrier2(cmd, &dependency);
}
```

cpp

Барьер после загрузки данных через transfer и барьер для последующего потребителя результата задаются отдельно.

## Dispatch для больших массивов

## Все шейдеры поддерживают линейную нумерацию через двумерный dispatch:

```
void dispatchLinear(uint64_t groups)
{
    uint32_t x = uint32_t(std::min(
        groups,
        uint64_t(limits.maxComputeWorkGroupCount[0])
    ));

    uint32_t y = uint32_t((groups + x - 1) / x);

    assert(y <= limits.maxComputeWorkGroupCount[1]);

    vkCmdDispatch(cmd, x, y, 1);
}
```

cpp

Не вызывайте функцию при `groups == 0`.

## Рекурсивный scan

## Это запись команд на CPU, **не чтение промежуточных результатов с GPU**:

```
void exclusiveScan(
    Buffer input,
    Buffer output,
    uint32_t count,
    uint32_t level)
{
    uint32_t blocks =
        uint32_t((uint64_t(count) + 1023) / 1024);

    Buffer sums = scratch[level].sums;
    Buffer sumsPrefix = scratch[level].prefix;

    // Bind scan_blocks:
    //   0 = input
    //   1 = output
    //   2 = sums
    //
    // Push: count

    dispatchLinear(blocks);
    computeBarrier(cmd);

    if (blocks > 1)
    {
        exclusiveScan(
            sums,
            sumsPrefix,
            blocks,
            level + 1
        );

        // Bind scan_add:
        //   0 = output
        //   1 = sumsPrefix
        //
        // Push: count

        dispatchLinear(blocks);
        computeBarrier(cmd);
    }
}
```

cpp

Буферы разных уровней scan должны быть выделены заранее и не перекрываться во время использования.

## Основной цикл

```
if (count < 2)
    return input;

Buffer srcKeys = keysA;
Buffer dstKeys = keysB;

Buffer srcValues = valuesA;
Buffer dstValues = valuesB;

uint32_t groups =
    uint32_t((uint64_t(count) + 1023) / 1024);

uint32_t histogramLength = groups * 256u;

for (uint32_t shift = 0; shift < 32; shift += 8)
{
    // 1. Histogram.
    //
    // Bind radix_histogram:
    //   0 = srcKeys
    //   1 = histogram
    //
    // Push: { count, shift, groups }

    dispatchLinear(groups);
    computeBarrier(cmd);

    // 2. Global histogram prefix.
    exclusiveScan(
        histogram,
        histogramPrefix,
        histogramLength,
        0
    );

    // 3. Stable scatter.
    //
    // Bind radix_scatter:
    //   0 = srcKeys
    //   1 = srcValues, если WITH_VALUES
    //   2 = dstKeys
    //   3 = dstValues, если WITH_VALUES
    //   4 = histogramPrefix
    //
    // Push: { count, shift, groups }

    dispatchLinear(groups);
    computeBarrier(cmd);

    std::swap(srcKeys, dstKeys);
    std::swap(srcValues, dstValues);
}

return {srcKeys, srcValues};
```

cpp

После четырёх проходов результат окажется в исходной стороне ping-pong — `keysA`/`valuesA`.

Обнуление глобальной гистограммы перед проходом не требуется: histogram shader записывает все её элементы, включая нулевые bin.

# 7\. Другие типы ключей

Меняется только `orderedKey()` в общем файле. Исходные биты ключа в выходном массиве сохраняются.

### `int32_t`

```
uint orderedKey(uint raw)
{
    return raw ^ 0x80000000u;
}
```

glsl

### `float32`

```
uint orderedKey(uint raw)
{
    return (raw & 0x80000000u) != 0u
        ? ~raw
        : (raw ^ 0x80000000u);
}
```

glsl

Для float необходимо заранее определить требуемую семантику `NaN` и `-0/+0`: эта трансформация различает знаковые нули и упорядочивает NaN по преобразованным битам, а не по пользовательскому компаратору.

## Для сортировки по убыванию инвертируйте преобразованный ключ:

```
return ~ascendingOrderedKey;
```

# 8\. Что тюнить для конкретной RTX

Этот вариант — отправная точка для высокопроизводительной реализации, но не доказанный абсолютный максимум.

## Основные направления:

Параметр

Что сравнить

Размер tile

512, 1024, 2048

Workgroup

128 и 256 потоков

Radix

4, 6, 8 бит

Payload

Только ключи против key-value

Локальная перестановка

Shared reorder против прямого scatter

Маленькие массивы

Отдельная single-workgroup сортировка

Изменения размера workgroup и radix требуют согласованного изменения массивов, scan и индексирования — это не просто замена одной константы.

## Особенно важно:

*   Для payload больше 4–8 байт обычно выгоднее сортировать **ключ + индекс**, а payload переставлять один раз после сортировки.
*   Для массивов до одного tile нужен отдельный путь: несколько общих dispatch здесь будут дороже самой сортировки.
*   Bin-major гистограмма упрощает scan, но её запись имеет большой stride. На больших массивах стоит отдельно измерить вариант с tiled transpose.
*   Проверяйте число регистров, spills и occupancy через NVIDIA Nsight Graphics; увеличение `ITEMS` не гарантирует ускорения.
*   Не используйте `vkQueueWaitIdle()` между проходами. Вся сортировка записывается в command buffer и выполняется без синхронизации с CPU.

## Для сравнения: без учёта гистограмм и scan эта схема переносит примерно:

```
key-only:   48 × N байт за полную сортировку;
key-value:  80 × N байт за полную сортировку.
```

text

Следующий уровень оптимизации для больших массивов — **Onesweep / decoupled look-back**. Он может сократить трафик и число dispatch, но требует отдельного, тщательно проверенного протокола публикации prefix и обеспечения прогресса. Наивный spin-wait между workgroup для этого использовать нельзя.

**Представленный код я здесь не компилировал и не профилировал.** Перед внедрением проверьте его против стабильной CPU-сортировки на случайных, одинаковых, уже отсортированных ключах и размерах около границ `32`, `256` и `1024`. Для проверки стабильности используйте исходный индекс как `value`.
