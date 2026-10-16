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
